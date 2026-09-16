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

- Before activation: Linux-сборка проверенных исходников, сверка hashes текущей установки, отсутствие активного minter и read-only preflight на сервере.
- Сравнить реальные задержки чтения/свежесть блока на EC2 отдельно. Увеличивать `readConcurrency` выше четырёх только по результатам замеров с учётом квоты RPC.

## Residual Risk

- Числа benchmark получены на macOS debug builds с искусственными 20 мс на HTTP-запрос; это не измерение AWS/mainnet и не прирост вероятности минта.
- При пяти выборках nearest-rank p95/p99 равны максимуму; устойчивые хвостовые задержки не оценены.
- RPC остаётся доверенным источником состояния. Один номер блока не доказывает отсутствие fork/reorg или недостоверного ответа провайдера.
- Параллелизм может увеличить кратковременную нагрузку на провайдера. Автоматические повторы и лимиты RPC не обходятся.
- Состояние может измениться между последней проверкой и исполнением; симуляция не резервирует NFT.
- На момент этого локального отчёта новая версия не активирована на EC2. Развёртывание ноды Robinhood — отдельная параллельная задача.
