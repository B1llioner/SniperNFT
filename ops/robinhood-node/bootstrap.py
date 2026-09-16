#!/usr/bin/env python3
"""Reviewed one-host Nitro bootstrap. Default is read-only planning.

No AWS API or credentials are used. IMDSv2 supplies only instance identity.
Run --apply only on the explicitly selected new node, after filling the snapshot
metadata. Instance-store loss is never repaired by automatically reformatting.
"""

import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

GIB = 1024**3
APPROVED_IMAGES = {
    # Snapshot rc3 and stable release are built from the SAME Git commit.
    "v3.11.4-rc.3-7d5ac27": (
        "v3.11.4-7d5ac27",
        "sha256:460918143cfdccc3aa984db8ca0c0d83b6054cec47ff10142bde4052054408ed",
    ),
}
SNAPSHOT_HOST = "robinhood-snapshots.offchainlabs.com"
IMAGE_REPO = "offchainlabs/nitro-node"
MODEL = "Amazon EC2 NVMe Instance Storage"
MOUNT = Path("/srv/robinhood")
INSTALL = Path("/etc/vinos-robinhood-node")
STATE = INSTALL / "install.json"
READY = INSTALL / "ready.json"
ARRAY = "/dev/md/vinosrobinhood"
CONFIG = INSTALL / "config"
SERVICE = "vinos-robinhood-node.service"
SNAPSHOT_SERVICE = "vinos-robinhood-snapshot.service"
SNAPSHOT_DIR = MOUNT / "snapshot"
CONTAINER = "vinos-robinhood-node"
INSTALLED_SCRIPT = Path("/usr/local/libexec/vinos-robinhood-node-bootstrap.py")
CHAIN_URL = "https://cdn.robinhood.com/assets/generated_assets/hoodchain_docsite/chain-node-configs/robinhood-chain-info.json"
GENESIS_URL = "https://cdn.robinhood.com/assets/generated_assets/hoodchain_docsite/chain-node-configs/robinhood-genesis.json"
SNAPSHOT_URL = "https://robinhood-snapshots.offchainlabs.com/robinhood%20chain/2026-09-11-145f3b5b/full-path.tar"
# Exact public metadata.json verified independently before installation. The
# provider publishes parts but no legacy Nitro .manifest.txt or whole .sha256.
SNAPSHOT_PARTS = (
    {"name": "full-path.tar.part0000", "size": 536870912000,
     "sha256": "f12ddeab74e37c23217f72e5b1e4d3f76453e7e8f9c6d0edf655facaa9eab940"},
    {"name": "full-path.tar.part0001", "size": 250113525760,
     "sha256": "3838e48a0a5edb69584fb6aa27dbfa8f0deab0c44eb6d63e776e0e0bb340174d"},
)


class Refused(RuntimeError):
    pass


def require(condition, reason):
    if not condition:
        raise Refused(reason)


def run(argv, timeout=30, allowed=(0,)):
    result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, check=False)
    require(result.returncode in allowed, "COMMAND_FAILED:" + Path(argv[0]).name)
    require(len(result.stdout) <= 2_000_000, "COMMAND_OUTPUT_TOO_LARGE")
    return result.stdout.decode("utf-8", "strict")


def install_command(argv, timeout):
    # No secret-bearing arguments; inherited output does not accumulate in RAM.
    result = subprocess.run(argv, timeout=timeout, check=False)
    require(result.returncode == 0, "INSTALL_COMMAND_FAILED:" + Path(argv[0]).name)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch(url, maximum=2_000_000, data=None, headers=None, method=None):
    request = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=20) as response:
        require(response.status == 200, "HTTP_RESPONSE_NOT_OK")
        body = response.read(maximum + 1)
    require(len(body) <= maximum, "HTTP_RESPONSE_TOO_LARGE")
    return body


def identity():
    # The only IMDS paths allowed here are token + identity document. Never
    # enumerate IAM roles or request credentials from instance metadata.
    token = fetch("http://169.254.169.254/latest/api/token", 4096, data=b"",
                  headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"}, method="PUT")
    return json.loads(fetch("http://169.254.169.254/latest/dynamic/instance-identity/document",
                            headers={"X-aws-ec2-metadata-token": token.decode("ascii")}))


def mounted(row):
    mounts = row.get("mountpoints")
    require(mounts is None or isinstance(mounts, list), "INVALID_MOUNTPOINT_METADATA")
    return bool(row.get("mountpoint")) or any(value for value in (mounts or []))


def blank_instance_disk(rows, requested, minimum_bytes):
    """Pure admission gate. Every nested child/partition is disallowed."""
    require(re.fullmatch(r"/dev/nvme[0-9]+n[0-9]+", requested) is not None,
            "DISK_PATH_MUST_BE_CANONICAL_NVME_NAMESPACE")
    matches = [row for row in rows if row.get("path") == requested]
    require(len(matches) == 1, "DISK_NOT_UNIQUELY_IDENTIFIED")
    disk = matches[0]
    require(disk.get("type") == "disk", "NOT_A_WHOLE_DISK")
    require(str(disk.get("model", "")).strip() == MODEL, "NOT_EC2_INSTANCE_STORAGE")
    require(not disk.get("children"), "DISK_HAS_CHILDREN_OR_PARTITIONS")
    require(not disk.get("pkname"), "DISK_HAS_PARENT")
    require(not mounted(disk), "DISK_IS_MOUNTED")
    require(not disk.get("fstype"), "DISK_ALREADY_HAS_FILESYSTEM")
    require(disk.get("ro") in (False, 0, "0"), "DISK_READ_ONLY_OR_UNKNOWN")
    require(isinstance(disk.get("serial"), str) and disk["serial"].strip(), "DISK_SERIAL_MISSING")
    size = int(disk.get("size", 0))
    require(size >= minimum_bytes + 4 * GIB, "INSTANCE_DISK_TOO_SMALL_FOR_SNAPSHOT_BUDGET")
    return {"path": requested, "serial": disk["serial"].strip(), "size": size,
            "model": MODEL, "maj:min": disk.get("maj:min")}


def blank_pair(rows, requested, minimum_bytes):
    require(isinstance(requested, list) and len(requested) == 2 and len(set(requested)) == 2,
            "EXACTLY_TWO_DISTINCT_INSTANCE_DISKS_REQUIRED")
    disks = [blank_instance_disk(rows, path, 0) for path in requested]
    require(disks[0]["serial"] != disks[1]["serial"], "DUPLICATE_DEVICE_IDENTITY")
    require(sum(d["size"] for d in disks) >= minimum_bytes + 8 * GIB,
            "ARRAY_TOO_SMALL_FOR_SNAPSHOT_BUDGET")
    return disks


def disk_inventory():
    return json.loads(run(["lsblk", "--json", "--bytes", "--output",
        "NAME,KNAME,PATH,TYPE,SIZE,MODEL,SERIAL,FSTYPE,MOUNTPOINTS,PKNAME,RO,MAJ:MIN"]))["blockdevices"]


def no_signatures(device):
    info = os.lstat(device)
    require(stat.S_ISBLK(info.st_mode), "NVME_PATH_NOT_DIRECT_BLOCK_DEVICE")
    signatures = json.loads(run(["wipefs", "--no-act", "--json", device]))
    require(signatures.get("signatures") == [], "DISK_HAS_EXISTING_SIGNATURES")
    return info.st_rdev


def validate_spec(spec):
    required = {"instance_id", "disks", "memory_gib", "snapshot_url", "snapshot_nitro_version",
                "snapshot_state_scheme", "required_free_bytes"}
    require(set(spec) == required, "SPEC_FIELDS_MISMATCH")
    require(re.fullmatch(r"i-[0-9a-f]{17}", spec["instance_id"]) is not None, "INVALID_INSTANCE_ID")
    require(spec["memory_gib"] in (64, 128), "MEMORY_PROFILE_MUST_BE_64_OR_128")
    require(isinstance(spec["required_free_bytes"], int)
            and 100 * GIB <= spec["required_free_bytes"] <= 100_000 * GIB,
            "REQUIRED_FREE_BYTES_MUST_COME_FROM_SNAPSHOT_METADATA")
    url = urllib.parse.urlsplit(spec["snapshot_url"])
    require(url.scheme == "https" and url.hostname == SNAPSHOT_HOST and url.port in (None, 443)
            and not url.username and not url.password and not url.query and not url.fragment
            and url.path.startswith("/") and url.path != "/"
            and not any(c.isspace() for c in spec["snapshot_url"])
            and "\\" not in spec["snapshot_url"] and ".." not in url.path.split("/"),
            "SNAPSHOT_URL_NOT_APPROVED_OFFICIAL_PUBLIC_URL")
    require(spec["snapshot_nitro_version"] in APPROVED_IMAGES,
            "SNAPSHOT_NITRO_VERSION_NOT_REVIEWED_OR_IMAGE_NOT_APPROVED")
    require(spec["snapshot_state_scheme"] in ("hash", "path"), "UNKNOWN_SNAPSHOT_STATE_SCHEME")
    require(spec["snapshot_url"] == SNAPSHOT_URL
            and spec["snapshot_state_scheme"] == "path"
            and spec["snapshot_nitro_version"] == "v3.11.4-rc.3-7d5ac27",
            "SNAPSHOT_PART_METADATA_NOT_PINNED_FOR_THIS_PROFILE")
    require(spec["required_free_bytes"] >= sum(p["size"] for p in SNAPSHOT_PARTS) * 24 // 10,
            "SNAPSHOT_SPACE_BUDGET_BELOW_TWO_COPIES_PLUS_RESERVE")
    require(isinstance(spec["disks"], list) and len(spec["disks"]) == 2 and len(set(spec["disks"])) == 2,
            "TWO_DISTINCT_DISKS_REQUIRED")
    for disk in spec["disks"]:
        require(re.fullmatch(r"/dev/nvme[0-9]+n[0-9]+", disk) is not None, "INVALID_DISK_PATH")


def safe_directory(path, mode=0o755):
    if path.exists() or path.is_symlink():
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0, "UNTRUSTED_DIRECTORY")
        require(not info.st_mode & 0o022, "WRITABLE_INSTALL_DIRECTORY")
    else:
        path.mkdir(mode=mode)
    os.chmod(path, mode)


def atomic_file(path, data, mode):
    if path.exists() or path.is_symlink():
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                "UNTRUSTED_EXISTING_FILE")
        require(path.read_bytes() == data, "EXISTING_FILE_DIFFERS_REVIEW_REQUIRED")
        os.chmod(path, mode, follow_symlinks=False)
        return
    temporary = path.with_name(path.name + ".new")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def current_mount():
    text = run(["findmnt", "--json", "--mountpoint", str(MOUNT), "--output", "SOURCE,FSTYPE,TARGET"], allowed=(0, 1))
    if not text.strip():
        return None
    rows = json.loads(text).get("filesystems", [])
    require(len(rows) == 1, "AMBIGUOUS_NODE_MOUNT")
    return rows[0]


def verify_mount(uuid):
    mount = current_mount()
    require(mount and mount.get("target") == str(MOUNT) and mount.get("fstype") == "xfs",
            "NODE_INSTANCE_VOLUME_NOT_MOUNTED")
    source = mount["source"]
    actual = run(["blkid", "-s", "UUID", "-o", "value", source]).strip()
    require(actual == uuid, "NODE_MOUNT_UUID_MISMATCH")


def disk_free(minimum):
    require(shutil.disk_usage(MOUNT).free >= minimum, "NODE_DISK_SPACE_GUARD")


def space_check():
    info = STATE.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o077,
            "UNTRUSTED_INSTALL_STATE")
    state = json.loads(STATE.read_bytes())
    verify_mount(state["uuid"])
    disk_free(50 * GIB)


def array_info(device=ARRAY):
    if not Path(device).exists():
        return None
    pairs = run(["mdadm", "--detail", "--export", device]).splitlines()
    return dict(line.split("=", 1) for line in pairs if "=" in line)


def trusted_state():
    directory = INSTALL.lstat()
    info = STATE.lstat()
    require(stat.S_ISDIR(directory.st_mode) and directory.st_uid == 0 and not directory.st_mode & 0o077,
            "UNTRUSTED_STATE_DIRECTORY")
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o077
            and info.st_size <= 16_384, "UNTRUSTED_INSTALL_STATE")
    return json.loads(STATE.read_bytes())


def assemble_array():
    state = trusted_state()
    existing = array_info()
    if existing:
        require(existing.get("MD_UUID") == state["arrayUuid"], "ARRAY_UUID_MISMATCH")
        return
    # udev may already have assembled this UUID as /dev/md127 under another
    # name. Recreate only our alias to that exact array; never stop another one.
    arrays = sorted(Path("/sys/block").glob("md[0-9]*"))
    require(len(arrays) <= 16, "UNEXPECTED_ARRAY_COUNT")
    for array in arrays:
        candidate = "/dev/" + array.name
        if array_info(candidate).get("MD_UUID") == state["arrayUuid"]:
            safe_directory(Path("/dev/md"))
            require(not Path(ARRAY).is_symlink() and not Path(ARRAY).exists(), "ARRAY_ALIAS_OCCUPIED")
            os.symlink(candidate, ARRAY)
            return
    # Assemble by the saved UUID only. This path NEVER creates or formats.
    install_command(["mdadm", "--assemble", "--run", ARRAY, "--uuid=" + state["arrayUuid"]] + state["componentIds"], 90)
    require(array_info().get("MD_UUID") == state["arrayUuid"], "ARRAY_UUID_MISMATCH")


def persistent_device_id(path):
    ids = sorted(candidate for candidate in Path("/dev/disk/by-id").iterdir()
                 if candidate.name.startswith("nvme-Amazon_EC2_NVMe_Instance_Storage_")
                 and candidate.is_symlink() and os.path.realpath(candidate) == path
                 and not any(c.isspace() for c in str(candidate)))
    require(ids, "INSTANCE_DISK_HAS_NO_STABLE_BY_ID_PATH")
    return str(ids[0])


def official_configs():
    chain = fetch(CHAIN_URL)
    genesis = fetch(GENESIS_URL)
    parsed = json.loads(chain)
    require(isinstance(parsed, list) and len(parsed) == 1
            and parsed[0].get("chain-id") == 4663 and parsed[0].get("parent-chain-id") == 1,
            "OFFICIAL_CHAIN_CONFIG_MISMATCH")
    # Robinhood's custom genesis uses a JSON-encoded serializedChainConfig,
    # not the standard geth genesis `config` field.
    encoded = json.loads(genesis).get("serializedChainConfig")
    require(isinstance(encoded, str) and json.loads(encoded) == parsed[0].get("chain-config"),
            "OFFICIAL_GENESIS_CHAIN_MISMATCH")
    return chain, genesis


def snapshot_file(path, maximum=None):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
            and info.st_nlink == 1 and not info.st_mode & 0o022,
            "UNTRUSTED_SNAPSHOT_FILE")
    require(maximum is None or info.st_size <= maximum, "SNAPSHOT_FILE_EXCEEDS_EXPECTED_SIZE")
    return info


def verify_part(path, part):
    info = snapshot_file(path, part["size"])
    require(info.st_size == part["size"], "SNAPSHOT_PART_SIZE_MISMATCH")
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            digest.update(chunk)
    require(digest.hexdigest() == part["sha256"], "SNAPSHOT_PART_CHECKSUM_MISMATCH")


def download_part(directory, part):
    path = directory / part["name"]
    if path.exists() or path.is_symlink():
        snapshot_file(path, part["size"])
    else:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.fchmod(fd, 0o600)
        os.close(fd)
    url = SNAPSHOT_URL.rsplit("/", 1)[0] + "/" + part["name"]
    for attempt in range(1, 4):
        info = snapshot_file(path, part["size"])
        if info.st_size == part["size"]:
            verify_part(path, part)
            return
        print(json.dumps({"event": "snapshot_part_download", "part": part["name"],
                          "attempt": attempt, "resumeBytes": info.st_size, "totalBytes": part["size"]}), flush=True)
        try:
            result = subprocess.run([
                "curl", "--silent", "--show-error", "--fail", "--proto", "=https",
                "--proto-redir", "=https", "--max-redirs", "0", "--noproxy", "*",
                "--user-agent", "Mozilla/5.0", "--connect-timeout", "15",
                "--max-time", "21600", "--speed-limit", "1048576", "--speed-time", "120",
                "--max-filesize", str(part["size"]), "--continue-at", "-",
                "--output", str(path), "--url", url,
            ], timeout=21610, check=False)
            succeeded = result.returncode == 0
        except subprocess.TimeoutExpired:
            succeeded = False
        snapshot_file(path, part["size"])
        if succeeded:
            verify_part(path, part)
            print(json.dumps({"event": "snapshot_part_verified", "part": part["name"],
                              "bytes": part["size"]}), flush=True)
            return
        if attempt != 3:
            time.sleep(10)
    raise Refused("SNAPSHOT_DOWNLOAD_FAILED_AFTER_THREE_ATTEMPTS")


def verify_archive(path, parts):
    total = sum(part["size"] for part in parts)
    require(snapshot_file(path, total).st_size == total, "SNAPSHOT_ARCHIVE_SIZE_MISMATCH")
    with path.open("rb") as archive:
        for part in parts:
            digest = hashlib.sha256()
            remaining = part["size"]
            while remaining:
                chunk = archive.read(min(8 * 1024 * 1024, remaining))
                require(chunk, "SNAPSHOT_ARCHIVE_TRUNCATED")
                digest.update(chunk)
                remaining -= len(chunk)
            require(digest.hexdigest() == part["sha256"], "SNAPSHOT_ARCHIVE_CHECKSUM_MISMATCH")
        require(not archive.read(1), "SNAPSHOT_ARCHIVE_HAS_TRAILING_DATA")


def snapshot_stamp(path, parts):
    info = snapshot_file(path, sum(part["size"] for part in parts))
    return {"parts": list(parts), "size": info.st_size, "inode": info.st_ino,
            "device": info.st_dev, "mtimeNs": info.st_mtime_ns}


def remove_published_parts(directory, parts):
    for part in parts:
        path = directory / part["name"]
        if path.exists() or path.is_symlink():
            snapshot_file(path, part["size"])
            path.unlink()


def prepare_snapshot(directory, parts, downloader=download_part):
    """Only called under a root-owned directory + exclusive lock in production.

    A marker cannot authorize a changed archive. Without a marker (e.g. power
    loss after rename), the entire archive is checked against both part hashes.
    """
    archive = directory / "full-path.tar"
    temporary = directory / "full-path.tar.new"
    marker = directory / "complete.json"
    allowed = {p["name"] for p in parts} | {archive.name, temporary.name, marker.name,
                                           "complete.json.new", "download.lock"}
    require(all(p.name in allowed for p in directory.iterdir()), "UNEXPECTED_SNAPSHOT_DIRECTORY_CONTENT")
    if marker.exists() or marker.is_symlink():
        snapshot_file(marker, 16_384)
        require(json.loads(marker.read_bytes()) == snapshot_stamp(archive, parts),
                "SNAPSHOT_COMPLETION_MARKER_MISMATCH")
        remove_published_parts(directory, parts)
        return
    if archive.exists() or archive.is_symlink():
        verify_archive(archive, parts)
    else:
        for part in parts:
            downloader(directory, part)
        if temporary.exists() or temporary.is_symlink():
            snapshot_file(temporary, sum(p["size"] for p in parts))
            temporary.unlink()  # Only our interrupted, unpublished join.
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as target:
            os.fchmod(target.fileno(), 0o600)
            for part in parts:
                source_path = directory / part["name"]
                require(snapshot_file(source_path, part["size"]).st_size == part["size"],
                        "SNAPSHOT_PART_SIZE_MISMATCH")
                digest = hashlib.sha256()
                with source_path.open("rb") as source:
                    while chunk := source.read(8 * 1024 * 1024):
                        digest.update(chunk)
                        target.write(chunk)
                require(digest.hexdigest() == part["sha256"], "SNAPSHOT_JOIN_CHECKSUM_MISMATCH")
            target.flush()
            os.fsync(target.fileno())
            os.fchmod(target.fileno(), 0o644)
        os.replace(temporary, archive)
    # A leftover unpublished marker is never trusted without rehashing above.
    pending_marker = marker.with_name("complete.json.new")
    if pending_marker.exists() or pending_marker.is_symlink():
        snapshot_file(pending_marker, 16_384)
        pending_marker.unlink()
    atomic_file(marker, (json.dumps(snapshot_stamp(archive, parts), sort_keys=True) + "\n").encode(), 0o644)
    remove_published_parts(directory, parts)
    print(json.dumps({"event": "snapshot_archive_ready", "bytes": archive.stat().st_size,
                      "partsVerified": len(parts)}), flush=True)


def download_snapshot():
    require(os.geteuid() == 0, "SNAPSHOT_STAGE_REQUIRES_ROOT")
    state = trusted_state()
    validate_spec(state["spec"])
    verify_mount(state["uuid"])
    disk_free(50 * GIB)
    safe_directory(SNAPSHOT_DIR)
    lock_path = SNAPSHOT_DIR / "download.lock"
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+b") as lock:
        snapshot_file(lock_path, 0)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        prepare_snapshot(SNAPSHOT_DIR, SNAPSHOT_PARTS)


def bootstrap(spec, apply):
    validate_spec(spec)
    require(os.geteuid() == 0, "RUN_AS_ROOT_ON_SELECTED_NEW_NODE")
    ident = identity()
    require(ident.get("instanceId") == spec["instance_id"] and ident.get("region") == "us-east-2",
            "INSTANCE_OR_REGION_MISMATCH")
    require(re.fullmatch(r"i(?:3en|4i|7i|7ie)\.[a-z0-9]+", ident.get("instanceType", "")) is not None,
            "INSTANCE_FAMILY_NOT_REVIEWED")
    if STATE.exists():
        state = trusted_state()
        require(state.get("spec") == spec, "EXISTING_INSTALL_SPEC_DIFFERS")
        require(READY.exists() and not READY.is_symlink()
                and READY.read_text() == state["arrayUuid"] + "\n", "INCOMPLETE_INSTALL_REQUIRES_RECOVERY_REVIEW")
        verify_mount(state["uuid"])
        print(json.dumps({"event": "existing_node_install", "instanceId": spec["instance_id"], "formatted": False}))
        return
    require(not STATE.is_symlink(), "INSTALL_STATE_IS_SYMLINK")
    disks = blank_pair(disk_inventory(), spec["disks"], spec["required_free_bytes"])
    device_numbers = [no_signatures(disk["path"]) for disk in disks]
    component_ids = [persistent_device_id(disk["path"]) for disk in disks]
    require(not Path(ARRAY).exists() and not Path(ARRAY).is_symlink(), "ARRAY_NAME_ALREADY_EXISTS")
    require(current_mount() is None, "NODE_MOUNT_ALREADY_OCCUPIED")
    if MOUNT.exists():
        require(not MOUNT.is_symlink() and not any(MOUNT.iterdir()), "NODE_MOUNT_NOT_EMPTY")
    print(json.dumps({"event": "node_bootstrap_plan", "instanceId": spec["instance_id"], "instanceType": ident["instanceType"],
                      "disks": disks, "image": IMAGE_REPO + ":" + APPROVED_IMAGES[spec["snapshot_nitro_version"]][0],
                      "stateScheme": spec["snapshot_state_scheme"], "hostRpc": "127.0.0.1:8547", "hostWs": "127.0.0.1:8548",
                      "requiredFreeBytes": spec["required_free_bytes"], "apply": apply}))
    if not apply:
        return
    os_release = Path("/etc/os-release").read_text()
    require('ID="amzn"' in os_release and 'VERSION_ID="2023"' in os_release, "AMAZON_LINUX_2023_REQUIRED")
    mem_kib = int(re.search(r"^MemTotal:\s+(\d+) kB$", Path("/proc/meminfo").read_text(), re.M).group(1))
    require(mem_kib * 1024 >= spec["memory_gib"] * GIB * 9 // 10 and (os.cpu_count() or 0) >= 8,
            "HOST_MEMORY_OR_CPU_BELOW_SELECTED_PROFILE")
    chain, genesis = official_configs()
    require(shutil.which("curl") is not None, "CURL_REQUIRED_BEFORE_DISK_FORMAT")
    install_command(["dnf", "install", "-y", "docker", "xfsprogs", "mdadm"], 300)
    install_command(["systemctl", "enable", "--now", "docker"], 60)
    approved_tag, approved_digest = APPROVED_IMAGES[spec["snapshot_nitro_version"]]
    digest = IMAGE_REPO + "@" + approved_digest
    install_command(["docker", "pull", "--platform", "linux/amd64", digest], 1800)
    image = json.loads(run(["docker", "image", "inspect", digest]))[0]
    require(image["Config"].get("User") == "user" and image["Config"].get("WorkingDir", "").rstrip("/") == "/home/user",
            "PINNED_IMAGE_USER_OR_HOME_CHANGED")
    require(digest in image.get("RepoDigests", []), "IMAGE_DIGEST_MISMATCH")
    uid = int(run(["docker", "run", "--rm", "--network", "none", "--entrypoint", "id", digest, "-u"]))
    gid = int(run(["docker", "run", "--rm", "--network", "none", "--entrypoint", "id", digest, "-g"]))
    require(uid > 0 and gid > 0, "IMAGE_MUST_RUN_UNPRIVILEGED")
    require(not run(["docker", "ps", "-a", "--filter", "name=^/" + CONTAINER + "$", "--format", "{{.ID}}"]).strip(),
            "CONTAINER_NAME_ALREADY_EXISTS")
    # Final independent check immediately before the only formatting command.
    require(blank_pair(disk_inventory(), spec["disks"], spec["required_free_bytes"]) == disks,
            "DISK_IDENTITY_CHANGED")
    require([no_signatures(disk["path"]) for disk in disks] == device_numbers, "DISK_DEVICE_NUMBER_CHANGED")
    install_command(["mdadm", "--create", ARRAY, "--run", "--metadata=1.2", "--level=0", "--raid-devices=2"] + spec["disks"], 120)
    actual = os.path.realpath(ARRAY)
    require(re.fullmatch(r"/dev/md[0-9]+", actual), "ARRAY_DEVICE_PATH_INVALID")
    members = {path.name for path in (Path("/sys/block") / Path(actual).name / "slaves").iterdir()}
    require(members == {Path(d).name for d in spec["disks"]}, "ARRAY_MEMBERS_MISMATCH")
    array_uuid = array_info().get("MD_UUID")
    require(re.fullmatch(r"[0-9a-f]{8}(?::[0-9a-f]{8}){3}", array_uuid or ""), "ARRAY_UUID_INVALID")
    install_command(["mkfs.xfs", "-L", "RHNITRO", ARRAY], 120)  # Deliberately no -f.
    uuid = run(["blkid", "-s", "UUID", "-o", "value", ARRAY]).strip()
    require(re.fullmatch(r"[0-9a-f-]{36}", uuid) is not None, "NEW_FILESYSTEM_UUID_INVALID")
    safe_directory(MOUNT)
    safe_directory(INSTALL, 0o700)
    safe_directory(CONFIG)
    mount_unit = f"""[Unit]
Description=Dedicated Robinhood Nitro instance-store volume
Requires=vinos-robinhood-array.service
After=vinos-robinhood-array.service
Before={SERVICE}
[Mount]
What=/dev/disk/by-uuid/{uuid}
Where={MOUNT}
Type=xfs
Options=noatime
TimeoutSec=90
[Install]
WantedBy=multi-user.target
"""
    state = {"spec": spec, "uuid": uuid, "arrayUuid": array_uuid, "componentIds": component_ids,
             "disks": disks, "imageDigest": digest, "imageTag": approved_tag,
             "chainSha256": hashlib.sha256(chain).hexdigest(), "genesisSha256": hashlib.sha256(genesis).hexdigest()}
    atomic_file(STATE, (json.dumps(state, indent=2) + "\n").encode(), 0o600)
    safe_directory(INSTALLED_SCRIPT.parent)
    atomic_file(INSTALLED_SCRIPT, Path(__file__).read_bytes(), 0o755)
    array_unit = f"""[Unit]
Description=Assemble only the previously created Robinhood instance-store RAID0
After=systemd-udev-settle.service
Wants=systemd-udev-settle.service
Before=srv-robinhood.mount
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart={INSTALLED_SCRIPT} --assemble-array
TimeoutStartSec=120
"""
    atomic_file(Path("/etc/systemd/system/vinos-robinhood-array.service"), array_unit.encode(), 0o644)
    atomic_file(Path("/etc/systemd/system/srv-robinhood.mount"), mount_unit.encode(), 0o644)
    install_command(["systemctl", "daemon-reload"], 30)
    install_command(["systemctl", "enable", "--now", "srv-robinhood.mount"], 120)
    verify_mount(uuid)
    disk_free(spec["required_free_bytes"])
    data_dir = MOUNT / "nitro"
    data_dir.mkdir(mode=0o700)
    os.chown(data_dir, uid, gid)
    process_tmp = data_dir / "process-tmp"
    process_tmp.mkdir(mode=0o700)
    os.chown(process_tmp, uid, gid)
    safe_directory(SNAPSHOT_DIR)
    atomic_file(CONFIG / "robinhood-chain-info.json", chain, 0o644)
    atomic_file(CONFIG / "robinhood-genesis.json", genesis, 0o644)
    memory, go_memory = ("110g", "90GiB") if spec["memory_gib"] == 128 else ("52g", "42GiB")
    create = ["docker", "create", "--name", CONTAINER, "--label", "vinos.role=robinhood-readonly-node",
              "--stop-timeout", "120", "--memory", memory, "--memory-swap", memory,
              "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=5",
              "-e", "GOMEMLIMIT=" + go_memory, "-e", "TMPDIR=/home/user/.arbitrum/process-tmp",
              "--mount", f"type=bind,src={data_dir},dst=/home/user/.arbitrum",
              "--mount", f"type=bind,src={CONFIG},dst=/home/user/config,readonly",
              "--mount", f"type=bind,src={SNAPSHOT_DIR},dst=/home/user/snapshot,readonly",
              "-p", "127.0.0.1:8547:8547", "-p", "127.0.0.1:8548:8548", digest,
              "--chain.id=4663", "--parent-chain.id=1", "--persistent.global-config=/home/user/.arbitrum",
              "--chain.info-files=/home/user/config/robinhood-chain-info.json",
              "--init.genesis-json-file=/home/user/config/robinhood-genesis.json",
              "--parent-chain.connection.url=https://ethereum-rpc.publicnode.com",
              "--parent-chain.blob-client.beacon-url=https://ethereum-beacon-api.publicnode.com",
              "--node.feed.input.url=wss://feed.mainnet.chain.robinhood.com",
              "--execution.forwarding-target=null", "--node.staker.enable=false",
              "--execution.caching.state-scheme=" + spec["snapshot_state_scheme"],
              "--init.url=file:/home/user/snapshot/full-path.tar", "--init.validate-checksum=true",
              "--http.addr=0.0.0.0", "--http.port=8547", "--http.api=net,web3,eth", "--http.vhosts=localhost,127.0.0.1",
              "--ws.addr=0.0.0.0", "--ws.port=8548", "--ws.api=net,web3,eth",
              "--ws.origins=http://localhost,http://127.0.0.1"]
    install_command(create, 60)
    snapshot_service = f"""[Unit]
Description=Download and verify the two pinned Robinhood snapshot parts
Requires=srv-robinhood.mount
After=network-online.target srv-robinhood.mount
Wants=network-online.target
Before={SERVICE}
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart={INSTALLED_SCRIPT} --download-snapshot
TimeoutStartSec=172800
TimeoutStopSec=30
Restart=no
"""
    service = f"""[Unit]
Description=Robinhood read-only Nitro full node
Requires=docker.service srv-robinhood.mount {SNAPSHOT_SERVICE}
After=network-online.target docker.service srv-robinhood.mount {SNAPSHOT_SERVICE}
Wants=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=3
[Service]
Type=simple
ExecStartPre={INSTALLED_SCRIPT} --space-check
ExecStart=/usr/bin/docker start -a {CONTAINER}
ExecStop=/usr/bin/docker stop --time 120 {CONTAINER}
TimeoutStopSec=150
Restart=on-failure
RestartSec=20
[Install]
WantedBy=multi-user.target
"""
    guard = f"""[Unit]
Description=Robinhood node free-space and mount guard
[Service]
Type=oneshot
ExecStart={INSTALLED_SCRIPT} --space-check --stop-if-low
"""
    timer = """[Unit]
Description=Check Robinhood node free space each minute
[Timer]
OnBootSec=60
OnUnitActiveSec=60
Unit=vinos-robinhood-space.service
[Install]
WantedBy=timers.target
"""
    for name, content in [(SERVICE, service), (SNAPSHOT_SERVICE, snapshot_service),
                          ("vinos-robinhood-space.service", guard), ("vinos-robinhood-space.timer", timer)]:
        atomic_file(Path("/etc/systemd/system") / name, content.encode(), 0o644)
    install_command(["systemctl", "daemon-reload"], 30)
    install_command(["systemctl", "enable", SERVICE, "vinos-robinhood-space.timer"], 60)
    atomic_file(READY, (array_uuid + "\n").encode(), 0o600)
    # Queue dependencies without blocking this installation on a 787 GB fetch.
    install_command(["systemctl", "start", "--no-block", SERVICE, "vinos-robinhood-space.timer"], 60)
    print(json.dumps({"event": "node_bootstrap_started", "instanceId": spec["instance_id"],
                      "imageDigest": digest, "syncComplete": False, "rpc": "http://127.0.0.1:8547", "ws": "ws://127.0.0.1:8548"}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--space-check", action="store_true")
    parser.add_argument("--assemble-array", action="store_true")
    parser.add_argument("--download-snapshot", action="store_true")
    parser.add_argument("--stop-if-low", action="store_true")
    args = parser.parse_args()
    if args.download_snapshot:
        require(not args.apply and not args.space_check and not args.assemble_array
                and not args.stop_if_low and args.spec is None, "INVALID_SNAPSHOT_MODE")
        download_snapshot()
        return
    if args.assemble_array:
        require(not args.apply and not args.space_check and args.spec is None, "INVALID_ARRAY_MODE")
        assemble_array()
        return
    if args.space_check:
        try:
            space_check()
        except Exception:
            if args.stop_if_low:
                install_command(["systemctl", "stop", SERVICE, SNAPSHOT_SERVICE], 180)
            raise
        return
    require(args.spec is not None and not args.stop_if_low, "PUBLIC_SNAPSHOT_SPEC_REQUIRED")
    require(args.spec.stat().st_size <= 16_384, "SPEC_TOO_LARGE")
    bootstrap(json.loads(args.spec.read_bytes()), args.apply)


if __name__ == "__main__":
    try:
        main()
    except (Refused, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        # Do not serialize external response bodies or full process arguments.
        print(json.dumps({"event": "node_bootstrap_refused", "reason": str(error) if isinstance(error, Refused) else type(error).__name__}), file=sys.stderr)
        sys.exit(1)
