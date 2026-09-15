# Три одинаковых EC2-хоста для теста sequencer

Шаблон [infra/az-benchmark.template.json](infra/az-benchmark.template.json) создаёт по одному хосту в `use2-az1`, `use2-az2`, `use2-az3`. Эти три AZ находятся в Ohio (`us-east-2`). Для сопоставления результатов сохраняется **AZ ID**, а также имя зоны: ID обозначает одну физическую зону во всех аккаунтах. [Зоны AWS](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-availability-zones.html).

Все хосты используют один launch template: `c6i.large` по умолчанию, одинаковую Amazon Linux 2023 x86_64 AMI, Node.js 22, 12 GiB зашифрованного gp3 и IMDSv2. Тип можно поменять сразу для всех трёх хостов. Bootstrap устанавливает Node и npm из пакетов AL2023; образ привязан к одной версии репозитория пакетов. [Node.js в AL2023](https://docs.aws.amazon.com/linux/al2023/ug/nodejs.html), [версии репозиториев](https://docs.aws.amazon.com/linux/al2023/ug/managing-repos-os-updates.html).

У каждого хоста своя публичная подсеть и IPv4, общий internet gateway, без NAT gateway. Входящие порты закрыты; управление идёт через SSM Session Manager. Шаблон действует только в `us-east-2`: в нём явно указаны ID трёх зон Ohio.

Команды ниже запускает владелец AWS-аккаунта. При разработке облачные ресурсы не создавались. Оплачиваются EC2, EBS, публичные IPv4 и используемые сервисы/трафик; стоимость зависит от выбранного типа и длительности. Публичные IPv4 тарифицируются отдельно. [AWS IPv4](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-ec2-launchtemplate-networkinterface.html).

## 1. Подготовить один архив для всех хостов

На локальном компьютере нужны Node.js, настроенный AWS CLI и [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html). AWS-профиль должен иметь права на создание ресурсов CloudFormation/EC2/IAM, чтение AMI из SSM, работу с выбранным S3-объектом и запуск SSM-сессий.

Из каталога проекта:

```bash
node az-benchmark.mjs bundle --output az-benchmark.tgz
node az-benchmark.mjs aws-template --output az-benchmark.template.json
```

Архив содержит автономный сетевой CLI и документацию. Для этого теста кошелёк и приватный ключ не нужны. Тест реальных транзакций устанавливается отдельно из полного проекта по [SEQUENCER_BENCHMARK.md](SEQUENCER_BENCHMARK.md).

Выберите существующий **закрытый S3-бакет в своём аккаунте в `us-east-2`** и уникальное имя объекта. Для этого варианта используется шифрование SSE-S3 (`AES256`): роль EC2 получает только `s3:GetObject` для одного объекта, без прав KMS или записи в бакет.

```bash
AZ_BUNDLE_BUCKET='ИМЯ-ВАШЕГО-БАКЕТА'
AZ_BUNDLE_KEY='az-benchmark/run-01/az-benchmark.tgz'
AZ_BUNDLE_SHA256=$(node --input-type=module -e 'import {readFileSync} from "node:fs"; import {createHash} from "node:crypto"; console.log(createHash("sha256").update(readFileSync("az-benchmark.tgz")).digest("hex"))')

aws s3 cp az-benchmark.tgz "s3://$AZ_BUNDLE_BUCKET/$AZ_BUNDLE_KEY" \
  --region us-east-2 --sse AES256
```

SHA-256 сверяется на каждом хосте до распаковки. При изменении архива загружайте новый объект с новым именем и используйте его новый SHA-256. Приватных ключей и AWS access keys в параметрах или user data нет: EC2 получает доступ через свою IAM-роль.

## 2. Проверить зоны и создать стек

Сначала проверить доступность выбранного типа во всех трёх AZ:

```bash
aws ec2 describe-availability-zones --region us-east-2 \
  --filters Name=zone-type,Values=availability-zone \
  --query 'AvailabilityZones[].{Name:ZoneName,ID:ZoneId,State:State}' --output table

aws ec2 describe-instance-type-offerings --region us-east-2 \
  --location-type availability-zone-id \
  --filters Name=instance-type,Values=c6i.large \
  --query 'InstanceTypeOfferings[].{Type:InstanceType,Zone:Location}' --output table

aws cloudformation validate-template --region us-east-2 \
  --template-body file://az-benchmark.template.json

aws cloudformation create-stack --region us-east-2 \
  --stack-name robinhood-az-benchmark \
  --template-body file://az-benchmark.template.json \
  --capabilities CAPABILITY_IAM \
  --parameters \
    ParameterKey=InstanceType,ParameterValue=c6i.large \
    "ParameterKey=BundleBucket,ParameterValue=$AZ_BUNDLE_BUCKET" \
    "ParameterKey=BundleKey,ParameterValue=$AZ_BUNDLE_KEY" \
    "ParameterKey=BundleSha256,ParameterValue=$AZ_BUNDLE_SHA256"

aws cloudformation wait stack-create-complete --region us-east-2 \
  --stack-name robinhood-az-benchmark

aws cloudformation describe-stacks --region us-east-2 \
  --stack-name robinhood-az-benchmark \
  --query 'Stacks[0].Outputs' --output table
```

Тип должен быть доступен во всех трёх зонах; наличие в списке offerings не гарантирует свободную ёмкость в момент запуска. Outputs показывают три instance ID, AZ ID, имена зон и общий AMI ID. Метки `ProbeA/B/C` соответствуют `use2-az1/2/3`, а не обещают буквенные имена `us-east-2a/b/c`.

Чтобы создать только хосты без установки CLI, пропустите все три `Bundle*` параметра. Частичное заполнение этих параметров отклоняется шаблоном.

## 3. Проверить готовность и назначить общее время старта

Откройте по терминалу на каждый instance ID из Outputs:

```bash
aws ssm start-session --region us-east-2 --target i-INSTANCE-ID
```

`CREATE_COMPLETE` означает создание инфраструктуры. Дождитесь завершения bootstrap на **каждом** хосте:

```bash
sudo cloud-init status --wait
cat /var/lib/az-benchmark/ready.json
node --version
npm --version
chronyc tracking
node /opt/az-benchmark/az-benchmark.mjs --help
```

Если `ready.json` отсутствует, посмотрите `sudo cat /var/log/az-benchmark-bootstrap.log`. Не запускайте сравнение на хосте с незавершённым bootstrap. Убедитесь, что Node/AMI совпадают и часы синхронизированы. Для latency используется монотонный таймер; синхронные часы нужны для сравнения одного временного окна.

На своём компьютере вычислите один старт, например через 5 минут, и скопируйте **одно и то же значение** во все три терминала:

```bash
node -e 'console.log(new Date(Date.now() + 5 * 60 * 1000).toISOString())'
```

На хосте A (на B/C поменять только `--label` и имя файла):

```bash
mkdir -p ~/az-results
node /opt/az-benchmark/az-benchmark.mjs probe \
  --label ohio-a --ec2 --family 4 \
  --duration-seconds 1800 \
  --interval-ms 1000 --cold-interval-ms 30000 --timeout-ms 5000 \
  --start-at 'ОБЩЕЕ-ВРЕМЯ-СТАРТА-ISO' \
  --output ~/az-results/ohio-a.json
```

`--ec2` читает через IMDSv2 регион, имя/ID зоны и тип инстанса. CLI не запрашивает IAM credentials. AWS публикует AZ ID по metadata-пути `placement/availability-zone-id`. [EC2 metadata](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-metadata.html).

Пример задаёт одинаковый IPv4-путь и частоту на трёх хостах. Endpoint по умолчанию — `https://sequencer.mainnet.chain.robinhood.com`. Public endpoints ограничивают частоту запросов, поэтому увеличивать нагрузку без нужды не следует. `wss://feed.mainnet.chain.robinhood.com` служит отдельным потоком данных и не является путём отправки. [Адреса Robinhood](https://docs.robinhood.com/chain/connecting/).

## 4. Забрать JSON и сравнить

На завершившем тест EC2 запустите временную раздачу **только каталога результатов** на loopback:

```bash
python3 -m http.server 8000 --bind 127.0.0.1 --directory ~/az-results
```

В отдельном локальном терминале откройте SSM-туннель к этому instance ID:

```bash
aws ssm start-session --region us-east-2 --target i-INSTANCE-ID \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8000"],"localPortNumber":["18000"]}'
```

В ещё одном локальном терминале скачайте соответствующий файл:

```bash
curl --fail http://127.0.0.1:18000/ohio-a.json --output ohio-a.json
```

Остановите туннель и сервер через Ctrl+C, повторите для B/C с их instance ID и именами файлов. Входящие порты EC2 при этом остаются закрыты: соединение проходит через [SSM port forwarding](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-sessions-start.html#sessions-start-port-forwarding).

```bash
node az-benchmark.mjs compare ohio-a.json ohio-b.json ohio-c.json
```

Сравнивайте p50/p95/p99 вместе с ошибками, таймаутами, числом замеров и совпадением временных окон. Задержка HTTPS-ответа ещё не показывает порядок включения транзакций. После выбора кандидатов проверьте их [тестом deploy → mint](SEQUENCER_BENCHMARK.md) с реальными транзакциями и отдельными тестовыми кошельками: один кошелёк на нескольких хостах одновременно создаёт конфликт nonce.

## 5. Удалить временные ресурсы

После скачивания отчётов удалите весь стек:

```bash
aws cloudformation delete-stack --region us-east-2 \
  --stack-name robinhood-az-benchmark

aws cloudformation wait stack-delete-complete --region us-east-2 \
  --stack-name robinhood-az-benchmark

aws s3 rm "s3://$AZ_BUNDLE_BUCKET/$AZ_BUNDLE_KEY" --region us-east-2
```

Удаление стека завершает три EC2 и удаляет созданные им тома, сеть, security group, launch template и IAM-роль. S3-бакет не принадлежит стеку; команда `s3 rm` удаляет только загруженный объект. При включённом S3 versioning старые версии требуют отдельного удаления или lifecycle-политики. [Удаление объектов S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeletingObjects.html).
