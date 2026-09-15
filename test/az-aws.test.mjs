import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const template = JSON.parse(await readFile(new URL('../infra/az-benchmark.template.json', import.meta.url), 'utf8'));
const resources = template.Resources;
const instances = Object.values(resources).filter(resource => resource.Type === 'AWS::EC2::Instance');
const launch = resources.ProbeLaunchTemplate.Properties.LaunchTemplateData;

function evaluateRule(value, parameters) {
  if (typeof value !== 'object' || value === null) return value;
  if ('Ref' in value) return parameters[value.Ref];
  if ('Fn::Equals' in value) return value['Fn::Equals'].map(item => evaluateRule(item, parameters)).reduce((left, right) => left === right);
  if ('Fn::Not' in value) return !evaluateRule(value['Fn::Not'][0], parameters);
  if ('Fn::And' in value) return value['Fn::And'].every(item => evaluateRule(item, parameters));
  if ('Fn::Or' in value) return value['Fn::Or'].some(item => evaluateRule(item, parameters));
  throw new Error('Unexpected CloudFormation rule expression');
}

test('AWS benchmark creates three identically configured hosts in the three distinct Ohio AZ IDs', () => {
  assert.equal(instances.length, 3);
  const zones = instances.map(instance => {
    assert.deepEqual(Object.keys(instance.Properties).sort(), ['LaunchTemplate', 'NetworkInterfaces', 'Tags']);
    assert.deepEqual(instance.Properties.LaunchTemplate, instances[0].Properties.LaunchTemplate);
    const [network] = instance.Properties.NetworkInterfaces;
    assert.equal(instance.Properties.NetworkInterfaces.length, 1);
    assert.equal(network.AssociatePublicIpAddress, true);
    assert.equal(network.DeleteOnTermination, true);
    assert.deepEqual(network.GroupSet, [{ Ref: 'ProbeSecurityGroup' }]);
    const subnet = resources[network.SubnetId.Ref];
    assert.equal(subnet.Type, 'AWS::EC2::Subnet');
    assert.deepEqual(subnet.Properties.VpcId, { Ref: 'Vpc' });
    assert.ok(instance.DependsOn.includes('InternetRoute'));
    return subnet.Properties.AvailabilityZoneId;
  });
  assert.deepEqual(zones.sort(), ['use2-az1', 'use2-az2', 'use2-az3']);
  assert.deepEqual(launch.ImageId, { Ref: 'AmiParameter' });
  assert.deepEqual(launch.InstanceType, { Ref: 'InstanceType' });
  assert.match(template.Parameters.AmiParameter.Default, /al2023-ami-kernel-default-x86_64$/);
  for (const type of template.Parameters.InstanceType.AllowedValues) assert.match(type, /^(c6i|c7i|m6i|m7i)\.large$/);
});

test('AWS benchmark has no inbound access, requires IMDSv2 and deletes encrypted volumes', () => {
  assert.deepEqual(resources.ProbeSecurityGroup.Properties.SecurityGroupIngress, []);
  assert.equal(Object.values(resources).filter(resource => resource.Type === 'AWS::EC2::SecurityGroupIngress').length, 0);
  assert.equal(launch.MetadataOptions.HttpTokens, 'required');
  assert.equal(launch.MetadataOptions.HttpPutResponseHopLimit, 1);
  assert.equal(launch.BlockDeviceMappings[0].Ebs.Encrypted, true);
  assert.equal(launch.BlockDeviceMappings[0].Ebs.DeleteOnTermination, true);
  assert.equal(launch.BlockDeviceMappings[0].Ebs.VolumeType, 'gp3');
  assert.equal(launch.KeyName, undefined);
  assert.equal(resources.ProbeRole.Properties.RoleName, undefined);
  assert.equal(Object.values(resources).some(resource => resource.DeletionPolicy === 'Retain'), false);
});

test('optional bundle requires all three settings together for every input combination', () => {
  const assertion = template.Rules.CompleteBundleSettings.Assertions[0].Assert;
  const names = ['BundleBucket', 'BundleKey', 'BundleSha256'];
  for (let mask = 0; mask < 8; mask += 1) {
    const parameters = Object.fromEntries(names.map((name, index) => [name, mask & (1 << index) ? 'nonempty' : '']));
    assert.equal(evaluateRule(assertion, parameters), mask === 0 || mask === 7, `bundle field mask ${mask}`);
  }
});

test('AWS benchmark rejects deployment outside Ohio before resource creation', () => {
  const assertion = template.Rules.OhioRegionOnly.Assertions[0].Assert;
  assert.equal(evaluateRule(assertion, { 'AWS::Region': 'us-east-2' }), true);
  assert.equal(evaluateRule(assertion, { 'AWS::Region': 'us-east-1' }), false);
  assert.equal(evaluateRule(assertion, { 'AWS::Region': 'eu-west-1' }), false);
});

test('bundle role can read exactly one object and receives no S3 write or KMS permission', () => {
  const [condition, policies, fallback] = resources.ProbeRole.Properties.Policies['Fn::If'];
  assert.equal(condition, 'HasBundle');
  assert.deepEqual(fallback, { Ref: 'AWS::NoValue' });
  const [statement] = policies[0].PolicyDocument.Statement;
  assert.deepEqual(statement.Action, ['s3:GetObject']);
  assert.deepEqual(statement.Resource, { 'Fn::Sub': 'arn:${AWS::Partition}:s3:::${BundleBucket}/${BundleKey}' });
  assert.equal(statement.Resource['Fn::Sub'].includes('*'), false);
  assert.deepEqual(resources.ProbeRole.Properties.ManagedPolicyArns, [{ 'Fn::Sub': 'arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore' }]);
});

test('shell-interpolated bundle parameters reject shell control characters', () => {
  const valid = { BundleBucket: 'private-benchmark-artifacts', BundleKey: 'bench/run-01/az-benchmark.tgz', BundleSha256: 'a'.repeat(64) };
  for (const [name, example] of Object.entries(valid)) {
    const pattern = new RegExp(template.Parameters[name].AllowedPattern);
    assert.equal(pattern.test(example), true);
    assert.equal(pattern.test(''), true);
    for (const injected of ["'; touch /tmp/unwanted; '", '$(command)', '`command`', '${VARIABLE}', 'bad value', 'a*b']) {
      assert.equal(pattern.test(injected), false, `${name} must reject ${injected}`);
    }
  }
});

test('bootstrap script is valid bash for optional bundle states and checks archive before extraction', () => {
  const source = launch.UserData['Fn::Base64']['Fn::Sub'];
  assert.ok(source.indexOf('sha256sum --check --status') < source.indexOf('tar --extract'));
  assert.match(source, /alternatives --set node \/usr\/bin\/node-22/);
  assert.match(source, /systemctl enable --now amazon-ssm-agent/);
  assert.match(source, /systemctl enable --now chronyd/);
  assert.doesNotMatch(source, /PRIVATE_KEY|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|aws configure|eth_sendRawTransaction/);
  for (const filled of [false, true]) {
    const parameters = {
      'AWS::Region': 'us-east-2',
      BundleBucket: filled ? 'private-benchmark-artifacts' : '',
      BundleKey: filled ? 'bench/run-01/az-benchmark.tgz' : '',
      BundleSha256: filled ? 'a'.repeat(64) : '',
    };
    const rendered = source.replace(/\$\{([^}]+)\}/g, (_, name) => {
      assert.ok(name in parameters, `unexpected template substitution ${name}`);
      return parameters[name];
    });
    const result = spawnSync('bash', ['-n'], { input: rendered, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }
});
