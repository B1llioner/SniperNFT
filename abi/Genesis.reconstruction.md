# Восстановленный ABI Rare Friends Genesis

Контракт: [0x116eaa62241751e0c98da43d458600c6c17cd361](https://robin.etherscan.io/token/0x116eaa62241751e0c98da43d458600c6c17cd361#code). Сеть: Robinhood Chain, chainId 4663. Артефакт: [Genesis.reconstructed.json](Genesis.reconstructed.json).

## Статус и границы точности

Это **частичный восстановленный ABI**, пригодный для кодирования вызовов и декодирования выбранных ответов/логов; оригинальный ABI разработчика и верифицированный исходник Genesis отсутствуют. В runtime найдены **53 селектора функций**, в JSON включены **50 функций, 11 событий и 14 стандартных/подтверждённых ошибок**. Три функции и три собственных события оставлены неизвестными ниже.

Источник истины — [сохранённый runtime](../research/nft-runtime.hex), 17 135 байт, keccak256:

`0x7117a374c9b7784cd47f550531292764b04aa3a919089c806a79e47852f14b3c`.

Сигнатуры сопоставлены с реальными ветвями диспетчера, ABI-декодированием и поведением. Одна совпавшая 4-байтная подпись сама по себе не доказывает оригинальное имя: существуют коллизии. Имена аргументов восстановлены для удобства. Для read-only функций консервативно указано `view`, в том числе для getter констант; это подтверждает отсутствие записи состояния, но не восстанавливает точное исходное объявление `pure/view`.

EVM не различает некоторые исходные типы с одинаковым представлением: например, нулевой `bytes32` и нулевой `uint256` в ответе занимают одинаковые 32 байта. Для `ACCOUNT_SALT()` выбран `bytes32` согласно его использованию в ERC-6551. Поэтому JSON — ABI-совместимая реконструкция, а не утверждение о точном исходном Solidity. Неподтверждённые формы выходных данных в ABI не добавлены.

Все внешние функции Genesis отклоняют ненулевой `msg.value` общим прологом 0x05–0x0e. Изменяющие функции возвращаются в STOP 0x399, поэтому их ABI имеет `nonpayable` и пустой список outputs. При платном минте оплату принимает SeaDrop.

## Где Genesis участвует в минте

`Кошелёк / helper → SeaDrop.mintPublic или mintSigned → Genesis.getMintStats → Genesis.mintSeaDrop → ERC6551 Registry.createAccount`.

Именно Genesis хранит владельцев NFT и счётчики минта, выпускает токен и создаёт его ERC-6551 аккаунт. SeaDrop проверяет этап, лимит адреса, цену и подпись. После минта helper вызывает `Genesis.safeTransferFrom(helper, recipient, tokenId)`.

Прямой `Genesis.mintSeaDrop` с произвольного адреса запрещён проверкой `OnlyAllowedSeaDrop`. `mintPublic` и `mintSigned` относятся к SeaDrop, поэтому их нет в ABI Genesis. `totalSupply()`, `mint(address,uint256)`, `mint(uint256)` и `burn(uint256)` отсутствуют в диспетчере и в JSON.

## Подтверждённые функции

Уровень уверенности каждой строки: совпал селектор, подтверждена схема аргументов/результата и проверена указанная ветвь runtime. Для известных функций SeaDrop сигнатуры дополнительно сопоставлены с [официальным интерфейсом реализации NFT](https://github.com/ProjectOpenSea/seadrop/blob/main/src/ERC721SeaDrop.sol); сам Genesis не утверждается этой реализацией. Ниже 0x-смещения — позиции инструкций в сохранённом runtime.

| Селектор | Сигнатура | ABI: mutability → outputs | Entry и подтверждение |
| --- | --- | --- | --- |
| `0x01ffc9a7` | `supportsInterface(bytes4)` | view → bool | 0x31d; 0x742 → сравнение interfaceId с константами; bool-кодировщик 0x330 |
| `0x06fdde03` | `name()` | view → string | 0x345; 0x787: строка из слота 0; string-кодировщик 0x34d |
| `0x081812fc` | `getApproved(uint256)` | view → address | 0x35a; 0x816: проверка существования и mapping слота 4; address |
| `0x095ea7b3` | `approve(address,uint256)` | nonpayable → без результата | 0x385; 0x83d → 0x2352 → запись approval; STOP 0x399 |
| `0x099b6bfa` | `setProvenanceHash(bytes32)` | nonpayable → без результата | 0x39a; 0x84c: owner/self-check, запрет после первого минта, запись слота 17 |
| `0x0be76ed6` | `tokenBoundAccount(uint256)` | view → address | 0x3ad; 0x8f3: registry.account(...) через STATICCALL 0x972; address |
| `0x11464fbe` | `accountImplementation()` | view → address | 0x3c0; константа implementation; address-кодировщик 0x36d |
| `0x1b73593c` | `updatePublicDrop(address,(uint80,uint48,uint48,uint16,uint16,bool))` | nonpayable → без результата | 0x3e7; owner/self-check + allowed SeaDrop; ABI-декодирование и вызов соответствующей функции SeaDrop |
| `0x23b872dd` | `transferFrom(address,address,uint256)` | nonpayable → без результата | 0x3fa; 0xa46 → hook 0x2397 → стандартное обновление 0x2ceb; STOP 0x399 |
| `0x2a55205a` | `royaltyInfo(uint256,uint256)` | view → address receiver,uint256 royaltyAmount | 0x40d; 0xacf: royalty mapping/default; address+uint256 кодировщик 0x420 |
| `0x32cb6b0c` | `MAX_SUPPLY()` | view → uint256 | 0x43f; константа 0x400; uint256-кодировщик 0x448 |
| `0x3680620d` | `updateAllowList(address,(bytes32,string[],string))` | nonpayable → без результата | 0x456; owner/self-check + allowed SeaDrop; ABI-декодирование и вызов соответствующей функции SeaDrop |
| `0x42260b5d` | `royaltyBasisPoints()` | view → uint256 | 0x469; 0xbba: вторая часть royaltyInfo(0,10000); uint256 |
| `0x42842e0e` | `safeTransferFrom(address,address,uint256)` | nonpayable → без результата | 0x471; 0xbc7 → перегрузка 0x1fbc → transferFrom и ERC721 receiver-check |
| `0x44dae42c` | `setRoyaltyInfo((address,uint96))` | nonpayable → без результата | 0x484; 0xbe6: декодирование tuple, вызов 0x24fe, RoyaltyInfoUpdated |
| `0x48a4c101` | `updateAllowedFeeRecipient(address,address,bool)` | nonpayable → без результата | 0x497; owner/self-check + allowed SeaDrop; ABI-декодирование и вызов соответствующей функции SeaDrop |
| `0x511aa644` | `updateSignedMintValidationParams(address,address,(uint80,uint24,uint40,uint40,uint40,uint16,uint16))` | nonpayable → без результата | 0x4aa; owner/self-check + allowed SeaDrop; ABI-декодирование и вызов соответствующей функции SeaDrop |
| `0x55f804b3` | `setBaseURI(string)` | nonpayable → без результата | 0x4bd; 0xeba: owner/self-check, запись строки слота 15 |
| `0x56d3163d` | `setRenderer(address)` | nonpayable → без результата | 0x4e3; 0xf46: owner-check, запись адреса в слот 10, RendererUpdated |
| `0x60c308b6` | `updateAllowedSeaDrop(address[])` | nonpayable → без результата | 0x4f6; 0xfda → owner-check 0x25a0 → mapping слота 13/array слота 14 |
| `0x6352211e` | `ownerOf(uint256)` | view → address | 0x509; 0x101d → 0x231a: mapping слота 2, проверка существования; address |
| `0x64869dad` | `mintSeaDrop(address,uint256)` | nonpayable → без результата | 0x51c; 0x1027: reentrancy guard, разрешённый SeaDrop, счётчики и safeMint |
| `0x66251b69` | `updateCreatorPayoutAddress(address,address)` | nonpayable → без результата | 0x52f; owner/self-check + allowed SeaDrop; ABI-декодирование и вызов соответствующей функции SeaDrop |
| `0x6c0360eb` | `baseURI()` | view → string | 0x542; 0x110a: строка из слота 15; string-кодировщик 0x34d |
| `0x6f8b44b0` | `setMaxSupply(uint256)` | nonpayable → без результата | 0x54a; 0x1119: owner/self-check; принимает только 1024; MaxSupplyUpdated |
| `0x70a08231` | `balanceOf(address)` | view → uint256 | 0x55d; 0x11b1: mapping слота 3, uint256 |
| `0x715018a6` | `renounceOwnership()` | nonpayable → без результата | 0x570; 0x11f6: owner-check → запись нулевого owner 0x287d |
| `0x7a05bc82` | `updateDropURI(address,string)` | nonpayable → без результата | 0x578; owner/self-check + allowed SeaDrop; ABI-декодирование и вызов соответствующей функции SeaDrop |
| `0x7bc2be76` | `updateTokenGatedDrop(address,address,(uint80,uint16,uint48,uint48,uint8,uint32,uint16,bool))` | nonpayable → без результата | 0x58b; owner/self-check + allowed SeaDrop; ABI-декодирование и вызов соответствующей функции SeaDrop |
| `0x840e15d4` | `getMintStats(address)` | view → uint256 minterNumMinted,uint256 currentTotalSupply,uint256 maxSupply | 0x59e; 0x5ac: mapping слота 12, слот 9, 1024; три uint256 |
| `0x8ada6b0f` | `renderer()` | view → address | 0x5e9; слот 10, маска address; кодировщик 0x36d |
| `0x8da5cb5b` | `owner()` | view → address | 0x5fc; слот 8, маска address; кодировщик 0x36d |
| `0x8f2fc60b` | `setRoyalty(address,uint96)` | nonpayable → без результата | 0x60d; 0x12ed: owner-check, _setDefaultRoyalty в 0x24fe; uint96 decoder 0x365b |
| `0x8f7d5186` | `ACCOUNT_REGISTRY()` | view → address | 0x620; константа ERC6551 registry; address-кодировщик 0x36d |
| `0x938e3d7b` | `setContractURI(string)` | nonpayable → без результата | 0x64a; 0x1e47: owner/self-check, запись строки слота 16 |
| `0x95d89b41` | `symbol()` | view → string | 0x65d; 0x1ec1: строка из слота 1; string-кодировщик 0x34d |
| `0xa22cb465` | `setApprovalForAll(address,bool)` | nonpayable → без результата | 0x665; 0x1ed0 → 0x28cd: mapping слота 5, ApprovalForAll |
| `0xa2309ff8` | `totalMinted()` | view → uint256 | 0x678; чтение слота 9; uint256-кодировщик 0x448 |
| `0xa4830114` | `emitBatchMetadataUpdate(uint256,uint256)` | nonpayable → без результата | 0x681; 0x1edb: owner/self-check, LOG1 двух uint256 |
| `0xad2f852a` | `royaltyAddress()` | view → address | 0x694; 0x1f4c: первая часть royaltyInfo(0,0) |
| `0xb2490c3b` | `getAllowedSeaDrop()` | view → address[] | 0x69c; 0x1f5d: address[] из слота 14; кодировщик 0x36ef |
| `0xb88d4fde` | `safeTransferFrom(address,address,uint256,bytes)` | nonpayable → без результата | 0x6b1; 0x1fbc → transferFrom и receiver-check 0x2995 |
| `0xc6ab67a3` | `provenanceHash()` | view → bytes32 | 0x6c4; слот 17; 32-байтный результат |
| `0xc87b56dd` | `tokenURI(uint256)` | view → string | 0x6cc; 0x1fd4: строковый результат, существование/baseURI/renderer; string-кодировщик 0x34d |
| `0xcb743ba8` | `updatePayer(address,address,bool)` | nonpayable → без результата | 0x6df; owner/self-check + allowed SeaDrop; ABI-декодирование и вызов соответствующей функции SeaDrop |
| `0xd2716312` | `ACCOUNT_SALT()` | view → bytes32 | 0x6f2; константа ноль; 32-байтный salt для registry; см. оговорку о типах |
| `0xd5abeb01` | `maxSupply()` | view → uint256 | 0x6f9; константа 0x400; uint256-кодировщик 0x448 |
| `0xe8a3d485` | `contractURI()` | view → string | 0x714; 0x2280: строка из слота 16; string-кодировщик 0x34d |
| `0xe985e9c5` | `isApprovedForAll(address,address)` | view → bool | 0x71c; 0x228f: mapping слота 5; bool |
| `0xf2fde38b` | `transferOwnership(address)` | nonpayable → без результата | 0x72f; 0x22bc: owner-check, ненулевой новый owner, запись слота 8 |

## Неизвестные функции: исключены из JSON

| Селектор | Entry / тело | Что подтверждено |
| --- | --- | --- |
| `0x56ccb734` | 0x4d0 | Без аргументов, возвращает address из слота 11. Имя неизвестно; это внешний обработчик, вызываемый при передаче NFT. |
| `0xe0089de1` | 0x701 → 0x222f | Один address, owner-check, запись слота 11, событие с topic0 `0x823bd22361520d051c94cecb2e3fe7d7ae903cd0d976df33095a53d2ac2901bd`. Имя неизвестно. |
| `0x911f456b` | 0x637 → 0x134a | Сложная динамическая конфигурация, выполняющая несколько owner-настроек через внешние вызовы к себе. Форма похожа на multiConfigure, но точный tuple не подтверждён и сигнатура не включена. |

Утилита `cast selectors` даёт приблизительные типы. Например, она может показывать `uint256[]` вместо `address[]` или `bytes` вместо сложного tuple. Её вывод не копировался в JSON без проверки.

## События

В JSON включены только события, для которых совпали полный topic0, число topics, размещение indexed-полей и данных: `Transfer`, `Approval`, `ApprovalForAll`, `OwnershipTransferred`, `BatchMetadataUpdate`, `ContractURIUpdated`, `AllowedSeaDropUpdated`, `ProvenanceHashUpdated`, `RoyaltyInfoUpdated`, `RendererUpdated`, `MaxSupplyUpdated`.

Ключевые позиции: Transfer 0x2db3/LOG4 0x2dd5; Approval 0x2c8e; ApprovalForAll 0x2966/LOG3 0x2990; OwnershipTransferred 0x28a6; BatchMetadataUpdate 0x1f25; RendererUpdated 0xf70/LOG2 0xf94; ProvenanceHashUpdated 0x8c4/LOG1 0x8ef. У `RendererUpdated` адрес indexed; у `RoyaltyInfoUpdated` и `ProvenanceHashUpdated` оба аргумента находятся в data.

Исключённые события с неизвестными именами:

| topic0 | Подтверждённая структура / место |
| --- | --- |
| `0x558a5655aa2a0708757ea0dd806b3c15047f2b776f927ea8d11d4dd7080ddb47` | tokenId и ERC-6551 account в indexed topics, пустой data; 0x283f → LOG3 0x286a. Есть в исходной транзакции. |
| `0x8039bd6e4e7dba001c8840eb2e118d9d131246faa7d0d04335f7305127ec0b10` | royalty recipient indexed, размер комиссии в data; 0xce9/0x131a, LOG2. |
| `0x823bd22361520d051c94cecb2e3fe7d7ae903cd0d976df33095a53d2ac2901bd` | новый адрес обработчика передачи; 0x2259. |

События конструктора, которых нет в runtime, не реконструировались. Событие ERC6551AccountCreated испускает registry, поэтому оно не относится к ABI Genesis.

## Ошибки

В JSON включены: `OnlyAllowedSeaDrop()`; восемь ошибок ERC-721; `OwnableUnauthorizedAccount(address)`, `OwnableInvalidOwner(address)`; две ошибки ERC-2981; `ReentrancyGuardReentrantCall()`. Их селекторы подтверждены построением revert-data в байткоде, включая оптимизацию PUSH4 + сдвиг. Список частичный: неизвестным собственным ошибкам не назначались придуманные имена. Ошибки SeaDrop в этот ABI не включены.

## Передача helper → основной кошелёк

В коде Genesis нет инструкций ORIGIN и нет проверки, запрещающей владельца-контракт. `mintSeaDrop` ведёт счётчик minted по адресу получателя в mapping слота 12. Внутренний цикл берёт старый totalMinted из слота 9, увеличивает его на quantity и выпускает tokenId `oldTotalMinted + i`, где i начинается с 1. Для quantity=1 новый ID равен oldTotalMinted+1. Перевод NFT не обнуляет счётчик minted.

Минт вызывает safeMint: EXTCODESIZE получателя проверяется в 0x29a0. У helper в конструкторе ещё нет runtime, поэтому receiver callback пропускается; контракт с уже развёрнутым кодом должен поддерживать onERC721Received. Последовательные вызовы нескольких helper происходят в одной транзакции, а не параллельно внутри EVM.

Путь transferFrom: 0x3fa → 0xa46 → 0x2397 → 0x2ceb. Стандартная проверка 0x2f8b/0x3006 принимает владельца, approved-адрес или approved operator. Дополнительно при обычной передаче вызывается обработчик из слота 11 с селектором `0x4eb98ee0` и tokenId. Имя метода неизвестно. Ошибка самого CALL ловится; но ненулевой адрес обработчика без кода вызывает revert на проверке EXTCODESIZE 0x2419. Обработчик также может потреблять газ и менять внешнее состояние. Поэтому полный маршрут проверяется локальной симуляцией с реальными зависимостями. safeTransferFrom дополнительно требует ERC721 receiver callback у основного получателя, если это контракт.

Для signed mint разрешение подписанта связано с конкретным minter: перенести готовую подпись кошелька на helper нельзя. Публичный этап использует другие условия SeaDrop и не требует этой подписи.

## Проверка артефакта

Локально проверены все 50 function selectors на наличие в диспетчере; 11 event topic0 найдены в runtime; ABI успешно декодировал Transfer исходной транзакции как tokenId 904; кодирование mintSeaDrop даёт селектор 0x64869dad. Read-only проверка getters на локальном форке сохранена отдельно: [Genesis.getter-validation.json](Genesis.getter-validation.json). Это тестовая копия сети, она может содержать синтетические транзакции и не является актуальным снимком live-состояния.

Пример загрузки:

```js
import fs from 'node:fs';
import { Contract } from 'ethers';
const abi = JSON.parse(fs.readFileSync('abi/Genesis.reconstructed.json', 'utf8'));
const genesis = new Contract('0x116eaa62241751e0c98da43d458600c6c17cd361', abi, provider);
const [mintedByWallet, totalMinted, maxSupply] = await genesis.getMintStats(walletAddress);
const account = await genesis.tokenBoundAccount(904);
```
