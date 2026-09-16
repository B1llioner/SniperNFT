import copy
import importlib.util
import unittest
import os
import tempfile
import stat
import hashlib
import json
import subprocess
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("bootstrap", Path(__file__).with_name("bootstrap.py"))
B = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(B)


def disk(index=1):
    return {"path": f"/dev/nvme{index}n1", "type": "disk", "size": 2_500_000_000_000,
            "model": "Amazon EC2 NVMe Instance Storage  ", "serial": f"AWS-SYNTHETIC-{index}",
            "fstype": None, "mountpoints": [None], "pkname": None, "ro": False,
            "maj:min": f"259:{index}"}


def spec():
    return {"instance_id": "i-0123456789abcdef0", "disks": ["/dev/nvme1n1", "/dev/nvme2n1"],
            "memory_gib": 64,
            "snapshot_url": "https://robinhood-snapshots.offchainlabs.com/robinhood%20chain/2026-09-11-145f3b5b/full-path.tar",
            "snapshot_nitro_version": "v3.11.4-rc.3-7d5ac27", "snapshot_state_scheme": "path",
            "required_free_bytes": 1_900_000_000_000}


class DiskAdmission(unittest.TestCase):
    def test_accepts_only_two_explicit_blank_instance_disks_and_ignores_ebs(self):
        ebs = {**disk(0), "model": "Amazon Elastic Block Store", "fstype": "xfs",
               "children": [{"mountpoints": ["/"]}]}
        result = B.blank_pair([ebs, disk(1), disk(2), disk(3)], spec()["disks"], 1_900_000_000_000)
        self.assertEqual([d["path"] for d in result], spec()["disks"])
        self.assertEqual(sum(d["size"] for d in result), 5_000_000_000_000)

    def test_rejects_root_ebs_filesystems_partitions_mounts_readonly_and_missing_identity(self):
        for changed in [
            {"model": "Amazon Elastic Block Store"}, {"model": "Amazon EC2 NVMe Instance Storage extra"},
            {"type": "part"}, {"fstype": "xfs"}, {"fstype": "linux_raid_member"},
            {"mountpoints": ["/"]}, {"mountpoints": ["/mnt/data"]}, {"mountpoint": "/boot"},
            {"children": [{"type": "part", "fstype": None, "mountpoints": [None]}]},
            {"children": [{"type": "raid0", "mountpoints": ["/srv/data"]}]},
            {"ro": True}, {"ro": None}, {"pkname": "nvme0n1"}, {"serial": None},
            {"serial": ""}, {"size": 100},
        ]:
            with self.subTest(changed=changed), self.assertRaises(B.Refused):
                B.blank_pair([{**disk(1), **changed}, disk(2)], spec()["disks"], 1_900_000_000_000)

    def test_a_safe_first_disk_never_authorizes_an_unsafe_second_disk(self):
        for second in [{**disk(2), "model": "Amazon Elastic Block Store"},
                       {**disk(2), "fstype": "ext4"}, {**disk(2), "mountpoints": ["/"]}]:
            with self.subTest(second=second), self.assertRaises(B.Refused):
                B.blank_pair([disk(1), second], spec()["disks"], 1_900_000_000_000)

    def test_duplicates_aliases_and_capacity_shortfall_are_rejected(self):
        for paths in [["/dev/nvme1n1"] * 2, ["/dev/nvme1n1"],
                      ["/dev/nvme1n1", "/dev/disk/by-id/x"],
                      ["/dev/nvme1n1", "/dev/nvme2n1p1"]]:
            with self.subTest(paths=paths), self.assertRaises(B.Refused):
                B.blank_pair([disk(1), disk(2)], paths, 1_900_000_000_000)
        with self.assertRaises(B.Refused):
            B.blank_pair([disk(1), {**disk(2), "serial": disk(1)["serial"]}], spec()["disks"], 1)
        with self.assertRaises(B.Refused):
            B.blank_pair([disk(1), disk(1), disk(2)], spec()["disks"], 1)
        with self.assertRaises(B.Refused):
            B.blank_pair([disk(1), disk(2)], spec()["disks"], 6_000_000_000_000)


class SnapshotAdmission(unittest.TestCase):
    def test_latest_path_snapshot_maps_only_to_stable_same_commit_digest(self):
        B.validate_spec(spec())
        tag, digest = B.APPROVED_IMAGES[spec()["snapshot_nitro_version"]]
        self.assertEqual(tag, "v3.11.4-7d5ac27")
        self.assertEqual(digest, "sha256:460918143cfdccc3aa984db8ca0c0d83b6054cec47ff10142bde4052054408ed")
        other = spec()
        other["snapshot_state_scheme"] = "hash"
        with self.assertRaisesRegex(B.Refused, "SNAPSHOT_PART_METADATA"):
            B.validate_spec(other)

    def test_rejects_unapproved_version_secret_urls_and_unreviewed_metadata(self):
        for key, value in [
            ("snapshot_nitro_version", "v3.11.2-3599aca"),
            ("snapshot_nitro_version", "v3.11.4-UNKNOWN"),
            ("snapshot_state_scheme", "unknown"), ("required_free_bytes", 0),
            ("snapshot_url", "https://evil.example/snapshot.tar"),
            ("snapshot_url", "https://secret@robinhood-snapshots.offchainlabs.com/snapshot.tar"),
            ("snapshot_url", "https://robinhood-snapshots.offchainlabs.com/snapshot.tar?token=secret"),
            ("snapshot_url", "https://robinhood-snapshots.offchainlabs.com/../snapshot.tar"),
            ("snapshot_url", "http://robinhood-snapshots.offchainlabs.com/snapshot.tar"),
            ("snapshot_url", "REPLACE_AFTER_METADATA"), ("memory_gib", 32),
        ]:
            wrong = spec()
            wrong[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(B.Refused):
                B.validate_spec(wrong)

    def test_placeholder_spec_is_rejected_before_identity_or_any_commands(self):
        import json
        placeholder = json.loads(Path(__file__).with_name("bootstrap.spec.example.json").read_bytes())
        with patch.object(B, "identity") as identity, patch.object(B, "run") as run, \
                patch.object(B, "install_command") as mutation:
            with self.assertRaises(B.Refused):
                B.bootstrap(placeholder, True)
            identity.assert_not_called()
            run.assert_not_called()
            mutation.assert_not_called()

    def test_restricted_inherited_umask_still_produces_readable_config_and_executable_helper(self):
        with tempfile.TemporaryDirectory() as directory:
            previous = os.umask(0o077)
            try:
                for name, mode in [("public.json", 0o644), ("helper.py", 0o755), ("state.json", 0o600)]:
                    target = Path(directory) / name
                    B.atomic_file(target, b"synthetic public fixture\n", mode)
                    self.assertEqual(stat.S_IMODE(target.stat().st_mode), mode)
            finally:
                os.umask(previous)

    def test_reboot_accepts_only_existing_array_with_exact_saved_uuid(self):
        expected = "12345678:12345678:12345678:12345678"
        with patch.object(B, "trusted_state", return_value={"arrayUuid": expected}), \
                patch.object(B, "array_info", side_effect=[None, {"MD_UUID": expected}]), \
                patch.object(B.Path, "glob", return_value=[Path("/sys/block/md127")]), \
                patch.object(B.Path, "is_symlink", return_value=False), \
                patch.object(B.Path, "exists", return_value=False), \
                patch.object(B, "safe_directory"), patch.object(B.os, "symlink") as alias, \
                patch.object(B, "install_command") as mutation:
            B.assemble_array()
            alias.assert_called_once_with("/dev/md127", B.ARRAY)
            mutation.assert_not_called()
        with patch.object(B, "trusted_state", return_value={"arrayUuid": expected}), \
                patch.object(B, "array_info", return_value={"MD_UUID": "another-volume"}), \
                patch.object(B, "install_command") as mutation:
            with self.assertRaises(B.Refused):
                B.assemble_array()
            mutation.assert_not_called()

    def test_interrupted_install_never_reports_success_or_formats_again(self):
        with patch.object(B.os, "geteuid", return_value=0), \
                patch.object(B, "identity", return_value={"instanceId": spec()["instance_id"], "region": "us-east-2", "instanceType": "i7ie.2xlarge"}), \
                patch.object(B.Path, "exists", lambda path: path == B.STATE), \
                patch.object(B, "trusted_state", return_value={"spec": spec(), "arrayUuid": "synthetic"}), \
                patch.object(B, "install_command") as mutation, \
                patch.object(B, "disk_inventory") as inventory:
            with self.assertRaisesRegex(B.Refused, "INCOMPLETE_INSTALL"):
                B.bootstrap(spec(), True)
            mutation.assert_not_called()
            inventory.assert_not_called()

    def test_custom_genesis_must_match_official_chain_configuration(self):
        import json
        chain_config = {"chainId": 4663, "arbitrum": {"InitialArbOSVersion": 51}}
        chain = json.dumps([{"chain-id": 4663, "parent-chain-id": 1, "chain-config": chain_config}]).encode()
        for valid in [True, False]:
            genesis = json.dumps({"serializedChainConfig": json.dumps(chain_config if valid else {"chainId": 1})}).encode()
            with patch.object(B, "fetch", side_effect=[chain, genesis]):
                if valid:
                    self.assertEqual(B.official_configs(), (chain, genesis))
                else:
                    with self.assertRaises(B.Refused):
                        B.official_configs()

    def test_wrong_instance_fails_before_disk_inventory_or_mutation(self):
        with patch.object(B.os, "geteuid", return_value=0), \
                patch.object(B, "identity", return_value={"instanceId": "i-fffffffffffffffff", "region": "us-east-2"}), \
                patch.object(B, "disk_inventory") as inventory, \
                patch.object(B, "install_command") as mutation:
            with self.assertRaises(B.Refused):
                B.bootstrap(spec(), True)
            inventory.assert_not_called()
            mutation.assert_not_called()


class SnapshotStaging(unittest.TestCase):
    def parts(self):
        return tuple({"name": f"full-path.tar.part{index:04d}", "size": len(body),
                      "sha256": hashlib.sha256(body).hexdigest()}
                     for index, body in enumerate((b"first fixture block", b"second fixture block")))

    def write_parts(self, directory):
        for part, body in zip(self.parts(), (b"first fixture block", b"second fixture block")):
            (directory / part["name"]).write_bytes(body)

    def test_partial_download_resumes_same_file_then_checks_exact_hash(self):
        part = self.parts()[0]
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            path = directory / part["name"]
            path.write_bytes(b"first")

            def curl(argv, **kwargs):
                self.assertEqual(argv[argv.index("--continue-at") + 1], "-")
                self.assertEqual(argv[argv.index("--output") + 1], str(path))
                self.assertEqual(argv[argv.index("--proto") + 1], "=https")
                self.assertNotIn("--location", argv)
                self.assertEqual(path.read_bytes(), b"first")
                with path.open("ab") as output:
                    output.write(b" fixture block")
                return SimpleNamespace(returncode=0)

            with patch.object(B.subprocess, "run", side_effect=curl) as request:
                B.download_part(directory, part)
                request.assert_called_once()
            self.assertEqual(path.read_bytes(), b"first fixture block")

    def test_three_network_failures_stop_without_publishing_or_discarding_partial(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            part = self.parts()[0]
            path = directory / part["name"]
            path.write_bytes(b"first")
            with patch.object(B.subprocess, "run", return_value=SimpleNamespace(returncode=28)) as request, \
                    patch.object(B.time, "sleep") as delay:
                with self.assertRaisesRegex(B.Refused, "AFTER_THREE_ATTEMPTS"):
                    B.download_part(directory, part)
                self.assertEqual(request.call_count, 3)
                self.assertEqual(delay.call_count, 2)
            self.assertEqual(path.read_bytes(), b"first")
            self.assertFalse((directory / "full-path.tar").exists())

    def test_completed_wrong_hash_is_not_downloaded_again_or_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            part = self.parts()[0]
            (directory / part["name"]).write_bytes(b"x" * part["size"])
            with patch.object(B.subprocess, "run") as request:
                with self.assertRaisesRegex(B.Refused, "CHECKSUM_MISMATCH"):
                    B.download_part(directory, part)
                request.assert_not_called()

    def test_join_rechecks_each_part_and_keeps_sources_when_corrupt(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.write_parts(directory)
            part = self.parts()[1]
            (directory / part["name"]).write_bytes(b"x" * part["size"])
            with self.assertRaisesRegex(B.Refused, "JOIN_CHECKSUM_MISMATCH"):
                B.prepare_snapshot(directory, self.parts(), downloader=lambda *_: None)
            self.assertFalse((directory / "full-path.tar").exists())
            self.assertFalse((directory / "complete.json").exists())
            self.assertTrue(all((directory / p["name"]).exists() for p in self.parts()))

    def test_publication_failure_keeps_parts_and_next_attempt_recovers(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.write_parts(directory)
            real_replace = B.os.replace

            def fail_publish(source, target):
                if Path(target).name == "full-path.tar":
                    raise OSError("synthetic interrupted publication")
                return real_replace(source, target)

            with patch.object(B.os, "replace", side_effect=fail_publish):
                with self.assertRaises(OSError):
                    B.prepare_snapshot(directory, self.parts(), downloader=lambda *_: None)
            self.assertTrue(all((directory / p["name"]).exists() for p in self.parts()))
            self.assertFalse((directory / "complete.json").exists())
            B.prepare_snapshot(directory, self.parts(), downloader=lambda *_: None)
            self.assertEqual((directory / "full-path.tar").read_bytes(), b"first fixture blocksecond fixture block")
            self.assertTrue((directory / "complete.json").is_file())
            self.assertFalse(any((directory / p["name"]).exists() for p in self.parts()))
            self.assertEqual(stat.S_IMODE((directory / "full-path.tar").stat().st_mode), 0o644)

    def test_existing_archive_without_marker_requires_complete_hash_recovery(self):
        for corrupt in (False, True):
            with self.subTest(corrupt=corrupt), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                archive = directory / "full-path.tar"
                body = b"first fixture blocksecond fixture block"
                archive.write_bytes((b"x" * len(body)) if corrupt else body)
                with patch.object(B, "download_part") as request:
                    if corrupt:
                        with self.assertRaisesRegex(B.Refused, "ARCHIVE_CHECKSUM_MISMATCH"):
                            B.prepare_snapshot(directory, self.parts(), downloader=request)
                        self.assertFalse((directory / "complete.json").exists())
                    else:
                        B.prepare_snapshot(directory, self.parts(), downloader=request)
                        self.assertTrue((directory / "complete.json").is_file())
                    request.assert_not_called()

    def test_completion_marker_reuses_archive_but_rejects_changed_inode_or_content_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.write_parts(directory)
            B.prepare_snapshot(directory, self.parts(), downloader=lambda *_: None)
            with patch.object(B, "verify_archive") as verify, patch.object(B, "download_part") as request:
                B.prepare_snapshot(directory, self.parts(), downloader=request)
                verify.assert_not_called()
                request.assert_not_called()
            archive = directory / "full-path.tar"
            stamp = archive.stat()
            os.utime(archive, ns=(stamp.st_atime_ns, stamp.st_mtime_ns + 1_000_000))
            with self.assertRaisesRegex(B.Refused, "COMPLETION_MARKER_MISMATCH"):
                B.prepare_snapshot(directory, self.parts(), downloader=lambda *_: None)

    def test_symlinks_hardlinks_oversize_and_writable_files_never_authorize_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source = directory / "source"
            source.write_bytes(b"fixture")
            target = directory / "target"
            target.symlink_to(source)
            with self.assertRaisesRegex(B.Refused, "UNTRUSTED"):
                B.snapshot_file(target)
            target.unlink()
            os.link(source, target)
            with self.assertRaisesRegex(B.Refused, "UNTRUSTED"):
                B.snapshot_file(target)
            target.unlink()
            with self.assertRaisesRegex(B.Refused, "EXCEEDS"):
                B.snapshot_file(source, 1)
            source.chmod(0o666)
            with self.assertRaisesRegex(B.Refused, "UNTRUSTED"):
                B.snapshot_file(source)


if __name__ == "__main__":
    unittest.main()
