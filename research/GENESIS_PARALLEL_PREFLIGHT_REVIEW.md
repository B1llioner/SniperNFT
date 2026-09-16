# Code Review Report: параллельные проверки перед Genesis mint

## Findings

### [Medium, исправлено] Независимые RPC-чтения последовательно задерживали подготовку

- File / line: `rust-genesis-minter/src/chain.rs:139`, `chain.rs:363`, `chain.rs:479`, `run.rs:1115`.
- Rule area: Rust, async/concurrency, performance-sensitive blockchain CLI.
- Related rule: ограничивать ресурсы, переиспользовать соединения и измерять изменения горячего участка; сохранять порядок зависимых проверок.
- Impact: публичный батч из десяти детей при одном разрешённом SeaDrop требовал 56 последовательных RPC-запросов в mainnet finalize. Сетевые ожидания увеличивали возраст подготовки и задерживали отправку.
- Reachability: каждый успешный `finalize_batch` такого батча, без дополнительных повторов.
- Evidence: при одинаковых 20 мс искусственной задержки каждого RPC полная подготовка занимала медианно 1315.96 мс на старом бинарнике и 454.55 мс с четырьмя читающими соединениями. Новый бинарник с одним соединением: 1326.26 мс.
- Fix: отдельный read-only пул из 1–8 прогретых постоянных клиентов. Независимые группы используют один выбранный блок, выдача результатов сохраняет порядок запросов.
- Required tests: пересечение запросов, ограничение параллелизма, соответствие ответов запросам, повторное использование HTTP/WS, отказ одной операции, отмена, таймаут, отсутствие отправок при неуспешной проверке.
- False-positive considerations: nonce ownership, подпись, durable intent и отправка не должны переноситься в этот пул. Полная симуляция и проверка policy после неё намеренно остаются последовательными.

После исправления блокирующих замечаний при независимой проверке транспорта и orchestration не обнаружено. Это локальное ревью изменения, не утверждение об отсутствии всех рисков системы.

## Summary

- Scope: `read_rpc.rs`, чтения в `chain.rs`, интеграция в `run.rs`, typed config, локальный benchmark и обновление installer pins.
- Profiles: Rust CLI, blockchain tooling, performance-sensitive async, security, deployment packaging.
- Branch: `feat/rust-parallel-preflight`; прежнее состояние сохранено в `fbe029a`.
- Overall risk: изменение затрагивает порядок наблюдения RPC, поэтому требуется проверка согласованности и остановки до подписи при любой ошибке.
- Verification: 60 Rust unit tests, 47 существующих EVM-сценариев, 2 новых concurrency EVM-сценария и 10 deploy tests прошли. Отдельный benchmark завершён успешно.

## Domain Logic Assessment

- Snapshot выбирает head с монотонной нижней границей; чтения кода, allowlist, supply и параметров используют его tag. Новый head не может быть старее уже подтверждённого/прочитанного.
- Для каждого ребёнка сохраняются supply/лимиты, signer bounds в signed-mode и точный `eth_call` от фабрики. Результаты всех выбранных детей должны пройти проверки.
- Quote сохраняет gas floor, block/Nitro gas caps, fee caps, общий бюджет и резерв. Баланс и confirmed nonce привязаны к блоку оценки; pending nonce обязан совпадать с confirmed.
- Точная симуляция всего батча завершается до нового снимка policy. Только после проверки policy и разрешений подписантов допускается отправка в пределах прежнего срока актуальности.
- Снижение supply конкурентами не отменяет корректный частичный результат; правила уже развёрнутой фабрики не менялись.
- Один владелец nonce, lock состояния, запись signed intent до сети и восстановление receipt сохранены.

## Rust Quality Assessment

- ReadRpc владеет максимум восемью существующими RpcClient. Sender продолжает использовать прежний последовательный RpcClient.
- Нет новых runtime, зависимостей, `unsafe`, production unwrap/panic, detached tasks или блокировок через await.
- Каждая волна ждёт все начатые futures; ошибка не запускает следующую волну. Отмена/ошибка транспорта запрещает повторное использование пула до явного reconnect.
- До сети проверяются все методы/форматы группы, максимум 300 запросов и 16 MiB сериализованных запросов. Индивидуальный запрос ограничен 4 MiB.
- Ответы ограничены прежними 4 MiB на RPC и новыми 16 MiB на накопленную группу; временно дополнительно существует одна волна до восьми ответов. Это ограничения сериализованных данных, не обещание точного RSS процесса.
- Дедупликация чтения одинаковых signer bounds сохраняется после финальной симуляции; различные подписанты проверяются параллельно.
- `preparationMs` измеряет весь finalize; `finalPreflightMs` сохраняет прежнюю более узкую границу. Подпись, отправка, ожидание и создание детей в эти показатели не входят.

## PostgreSQL Assessment

Not applicable: SQL, SQLx, базы данных и миграции отсутствуют в этом изменении.

## Security Assessment

- Пул принимает только девять явно перечисленных RPC-методов чтения. `eth_sendRawTransaction`, подписки и неизвестные методы отклоняются до отправки первого запроса группы.
- Сетевые таймауты, ID correlation, запрет redirects, TLS/loopback validation и удаление RPC error bodies наследуются от существующего клиента.
- Приватники, production config с секретами и облачные credentials для этих тестов не читались. В EVM используются только синтетические ключи свежей локальной сети.
- Совместная ошибка Remote + Timeout может вернуть первый по порядку Remote при уже закрытом пуле. Это консервативная остановка; автоматическое восстановление такого смешанного случая не гарантировано.
- Локальный installer принимает только проверенный kit04 как старую версию; явно фиксирует `readConcurrency=4` в новом профиле. Проверки активного процесса, старого config, state и checker сохраняются.

## Smart Contract Assessment

- Present: GenesisChildFactory и GenesisMintChild; Solidity и артефакты не менялись.
- Research dossier: `RUST_GENESIS_REVIEW.md`, `GENESIS_MUTABILITY_REVIEW.md`, `GENESIS_LIVE_UPDATES_REVIEW.md`.
- Relevant rules/invariants: доступ фабрики/детей, domain-bound signatures, replay, последовательность проверок и исполнения, ограничение газа, сохранение частичных результатов.
- Validation: существующие EVM-сценарии смены окна и отзыва signer после точной симуляции, конкурирующего минта, nonce lag, потерянного ACK и устаревшей подготовки пройдены.
- Проверка фактического mainnet inclusion новым бинарником в этот локальный benchmark не входит.

## Test Assessment

Команды:

```bash
cargo fmt --manifest-path rust-genesis-minter/Cargo.toml -- --check
cargo clippy --locked --offline --manifest-path rust-genesis-minter/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --offline --manifest-path rust-genesis-minter/Cargo.toml --all-targets --all-features
node --test test/rust-genesis-minter-evm.test.mjs
node --test --test-name-pattern 'Rust CLI parallel' test/rust-genesis-minter-evm.test.mjs
node --test test/genesis-check-deploy.test.mjs test/genesis-mint-deploy.test.mjs
```

- Rust: 60/60. Formatter и Clippy с запретом предупреждений прошли. Единственное замечание Clippy в synthetic HTTP parser исправлено.
- Существующий EVM-набор: 47/47, 113.62 с. Первый запуск был заблокирован sandbox на локальном `listen`; повтор с разрешённым loopback завершился успешно.
- Новые EVM tests: 2/2; десять child simulations пересекаются, используют один блок, завершаются до whole-batch simulation. Ошибка ребёнка при незавершённых соседних чтениях не допускает mint send.
- Deploy: 10/10, в том числе 17 случаев обновления pins/конфигурации/активного процесса. Это тесты локальной модели установки, не изменение EC2.
- Benchmark: один nonforked Anvil, production factory/child и тестовые NFT/SeaDrop, supply 910/1024, десять подготовленных детей, неизменные block/state/nonce. Один warmup и пять измерений каждого варианта в чередующемся порядке.
- Во время измерений нет ключевого ввода, подписи, отправки или обращений OpenSea. Только две начальные транзакции подготовки локальных контрактов.

## Benchmark

| Вариант | Медиана полной подготовки | Максимум из 5 | Одновременно читающих запросов |
| --- | ---: | ---: | ---: |
| Старый бинарник | 1315.96 мс | 1457.14 мс | 1 |
| Новый, readConcurrency=1 | 1326.26 мс | 1370.28 мс | 1 |
| Новый, readConcurrency=4 | 454.55 мс | 495.65 мс | 4 |

Выигрыш медианы старого/нового с четырьмя соединениями: **2.895×**, около **861 мс** в этих условиях. Медиана узкого финального участка: 457.67 → 178.37 мс.

Доказательства: `GENESIS_PARALLEL_PREFLIGHT_BENCHMARK.json`; полный trace локально в `.state/preflight-parallel-benchmark-20260916.json`. Baseline получен из `git archive fbe029a`; добавлены только общий таймер и поле `preparationMs`, без изменения расписания RPC. SHA бинарников сохранены в JSON.

Повтор при наличии собранных бинарников с одинаковой границей таймера:

```bash
node scripts/benchmark-genesis-preflight.mjs \
  --before /path/to/instrumented-baseline \
  --after rust-genesis-minter/target/debug/vinos-genesis \
  --samples 5 --delay-ms 20 \
  --output .state/preflight-benchmark-new.json
```

## Recommendations

- Linux-сборка, сверка hashes, проверка отсутствия активного minter и read-only preflight на сервере выполнены; результат активации ниже.
- Сравнить реальные задержки чтения/свежесть блока на EC2 отдельно. Увеличивать `readConcurrency` выше четырёх только по результатам замеров с учётом квоты RPC.

## Residual Risk

- Числа benchmark получены на macOS debug builds с искусственными 20 мс на HTTP-запрос; это не измерение AWS/mainnet и не прирост вероятности минта.
- При пяти выборках nearest-rank p95/p99 равны максимуму; устойчивые хвостовые задержки не оценены.
- RPC остаётся доверенным источником состояния. Один номер блока не доказывает отсутствие fork/reorg или недостоверного ответа провайдера.
- Параллелизм может увеличить кратковременную нагрузку на провайдера. Автоматические повторы и лимиты RPC не обходятся.
- Состояние может измениться между последней проверкой и исполнением; симуляция не резервирует NFT.
- Новая версия активирована на EC2 и проверена чтениями; платный mainnet mint этим обновлением не выполнялся. Собственная нода ещё восстанавливается из snapshot.

## Дополнение: подключение своей mainnet-ноды

После запроса пользователя на установку собственной ноды разрешены plaintext HTTP/WS по буквальному loopback IP только в `readRpc`/`watchRpc`. Отправляющие endpoints проверяются отдельно, в том числе при совпадении строки URL с reader: HTTPS/WSS остаются обязательными. DNS-имя `localhost` и remote/private IP без TLS не принимаются. Chain ID и Genesis/code-hash restrictions не меняются; `--local-test` не включается.

Независимый review не выявил блокеров. Все восемь config-тестов прошли, включая новое покрытие IPv4/IPv6 loopback, подмены hostname, plaintext sender и mainnet NFT identity; Clippy `-D warnings` прошёл. Эти изменения не меняют алгоритм/границу измеренного benchmark. Само переключение на локальный endpoint требует готовой синхронизированной ноды и не выполнено этим изменением.

## Серверная активация, 2026-09-16 UTC

Версия установлена на `i-0ef42c1e5475d7edb`, Ohio. До атомарной замены launcher
проверены отсутствие активного минтера и совпадение установленной версии kit04.
Сборка выполнена Rust 1.93.0 для Linux x86_64, release, locked, jobs=1.

- Source SHA256: `d844c0f38e61ec5f7fca08695fabf62ee3f20bcaf5d04918c715009a4faf5b4a`.
- Artifact SHA256: `d6a907bfd6b8e8838d0a85bef8ed465ce7578a6c510e8bbd038e2aa5eac262b7`.
- Binary SHA256: `6d7862ab815a955d9f566da3ebfa2ce67c868957d8b032e8f5cddeae98ffa59c`.
- Launcher SHA256: `70a3aff3453a239269d3d79f29b345e91b0f61ba1bb16c2065ce9018cc86a44d`.
- Install SSM: `03597df0-dd34-4f17-87f0-32a022731342`, Success.
- Verify SSM: `cc256366-517b-48e7-8b8d-40953c8d24af`, Success, `preflightPassed=true`.

Установленный профиль: `readConcurrency=4`, quantity=10, minQuantity=1,
чтения и watcher через PublicNode, отправка напрямую официальному HTTPS
секвенсору. Собственная нода на отдельном EC2 пока загружает snapshot;
переключения reader на неё ещё нет.

Проверка подтвердила прежнюю фабрику
`0xe90e51c3b5217012afc70573b57de363857b6f6d`, отсутствие pending-транзакции и
53 оставшихся NFT на наблюдаемом блоке. Число оставшихся может измениться.
Health-запрос `arb_checkPublisherHealth` официальному секвенсору получил HTTP200
примерно за 14.97 мс. Это проверка доступности, а не замер отправки или включения
транзакции. Приватный ключ не читался, транзакции не отправлялись.

Хеши state, прежнего config и checker до/после установки совпали. Процесс
ожидания минта не запускался: для платного запуска пользователь вводит ключ
непосредственно в терминале. Полное доказательство установки и проверок:
`.state/genesis-check-server-20260916/public-install-05/deployment-proof.json`.
