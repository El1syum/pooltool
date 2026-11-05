# Оригинальные ассеты игрового интерфейса

Источник: файл Figma [`Бильярд_Игра (Copy)`](https://www.figma.com/design/YPQR5qd4bL3LUjSRBzTuQH/?node-id=0-1), раздел «Игра».
Файлы получены из ссылок ассетов `get_design_context` соответствующих фреймов. SVG сохранены как оригинальные экспорты Figma: без перерисовки, растрирования, замены цветов или ручного переписывания геометрии.

| Локальный файл | Исходный фрейм Figma | Элемент / назначение | Размер экспорта |
| --- | --- | --- | --- |
| `contact-ring.svg` | [102:17407](https://www.figma.com/design/YPQR5qd4bL3LUjSRBzTuQH/?node-id=102-17407) | «Контур битка» | 154 × 154 |
| `contact-reticle.svg` | [102:17407](https://www.figma.com/design/YPQR5qd4bL3LUjSRBzTuQH/?node-id=102-17407) | «Прицел на битке» | 56 × 56 |
| `cue-ball.svg` | [103:3950](https://www.figma.com/design/YPQR5qd4bL3LUjSRBzTuQH/?node-id=103-3950) | «Биток», прибор точки контакта при Alt | 144 × 144 |
| `contact-safe-zone.png` | [103:3950](https://www.figma.com/design/YPQR5qd4bL3LUjSRBzTuQH/?node-id=103-3950) | Область безопасного контакта, оригинальный PNG-экспорт **2×**, не скриншот | 188 × 188; отображается 94 × 94 |
| `contact-dot.svg` | [103:3950](https://www.figma.com/design/YPQR5qd4bL3LUjSRBzTuQH/?node-id=103-3950) | «Выбранная точка» | 16 × 16 |
| `contact-leader.svg` | [103:3950](https://www.figma.com/design/YPQR5qd4bL3LUjSRBzTuQH/?node-id=103-3950) | «Указатель выбранного контакта» | 240.315 × 52.8881 |
| `power-track.svg` | [102:17640](https://www.figma.com/design/YPQR5qd4bL3LUjSRBzTuQH/?node-id=102-17640) | «Шкала»: дорожка, уровень, бегунок силы | 182 × 20 |
| `cue-elevation.svg` | [102:17640](https://www.figma.com/design/YPQR5qd4bL3LUjSRBzTuQH/?node-id=102-17640) | «Вид кия сбоку»: сукно, кий, биток, дуга наклона | 262 × 70 |
| `elevation-track.svg` | [102:17640](https://www.figma.com/design/YPQR5qd4bL3LUjSRBzTuQH/?node-id=102-17640) | «Дорожка наклона»: диапазон, заполнение, указатель | 192 × 16 |
| `power-reticle.svg` | [104:4567](https://www.figma.com/design/YPQR5qd4bL3LUjSRBzTuQH/?node-id=104-4567) | `Group 513`, ориентир направления и прицел | 264 × 264 |
| `direction-arrow.svg` | [102:17183](https://www.figma.com/design/YPQR5qd4bL3LUjSRBzTuQH/?node-id=102-17183) | «Горизонтальная регулировка» | 214.121 × 15.0607 |
| `menu.svg` | [102:16962](https://www.figma.com/design/YPQR5qd4bL3LUjSRBzTuQH/?node-id=102-16962) | `menu` | 20 × 20 |
| `power-gauge.svg` | [105:4605](https://www.figma.com/design/YPQR5qd4bL3LUjSRBzTuQH/?node-id=105-4605) | Актуальный Group 511; неизменённый Vector 3 используется для динамических индикаторов | 149.714 × 82.5888 |
| `legend-live.svg` | [102:17173](https://www.figma.com/design/YPQR5qd4bL3LUjSRBzTuQH/?node-id=102-17173) | Яркий шар в легенде общего вида | 10 × 10 |
| `legend-pocketed.svg` | [102:17176](https://www.figma.com/design/YPQR5qd4bL3LUjSRBzTuQH/?node-id=102-17176) | Приглушённый шар в легенде общего вида | 10 × 10 |

## Динамические части без изменения оригинала

`AssistRange.vue` и `CueElevationDiagram.vue` используют внешние SVG-фрагменты через `<use href="…svg#…">`. Уровень заполнения, положение бегунка и угол кия задаются трансформациями в компоненте; исходные файлы остаются неизменными.

Figma экспортировала кириллические `id` как числовые XML-сущности **байтов UTF-8**. После XML-разбора эти идентификаторы соответствуют последовательности символов с кодами байтов, а не обычной кириллице. Ссылка на фрагмент намеренно строится как `encodeURIComponent(String.fromCharCode(...new TextEncoder().encode(name)))`. Нельзя заменить её простым `encodeURIComponent(name)`: браузер не найдёт оригинальный элемент. Реальная загрузка этих фрагментов, ненулевые границы, пиксельная заливка и бегунки проверяются в Chromium и WebKit тестом `tests/match-assist.mjs`.

## Контрольные суммы оригиналов (SHA-256)

```text
291a58ae7166a9a5e6d48229e491eebbb88504c50995a3930025049c64ad84ca  contact-dot.svg
5a226aabfc1263a6a788445246bd650c58d6a1da8766f39f366576f5bf94e4d8  contact-leader.svg
20590852e8bb22e76b44ca5d0bd22d286ee332d411e539bc6a52d516ccd05eb9  contact-reticle.svg
ecc8ac779baa2e39f0a6ee98eb07a49c6db5c8a2d979a686d31a6e5679cb59d9  contact-ring.svg
3f9e1e9943b3663fce36a8dc95989d16ed5b619e7df6888b6378c388f2dc3145  contact-safe-zone.png
dacb7ef4a5839898d1e702791bafb51f4fdb7ef032b57c451d1999c138401b35  cue-ball.svg
4352acb85f9067ebf51c7662183478b5a65205a09cc5ea383038f9672206292d  cue-elevation.svg
0ee5b56bdb7ff6feaf274c6847c2608bfb46de50f1527a6b49a5ffc6a3a127c2  direction-arrow.svg
2286e4f6c1b02074566c92ce8c2273f678552ed3a648dc3594a5c9e5f2a0361f  elevation-track.svg
684caf2a1e5b6694d2bcdc6b6e452b6bc75ef10bb3dd57250254f657d9677fe0  menu.svg
d2be962b4c90445f8bb0420c6a09bf4b16e3a767ee93191a00918d8eac6f4251  power-reticle.svg
1cc016b9bf428f0d0bc67364f5c4fad3997f0ae0d00d0374c04e8823c69104c5  power-track.svg
0acf008430cd15af7d69ca1d8b579ab2052f7615754f69e4b53b1a3dd0a3d8f6  power-gauge.svg
c7fce4ccf5fbbaecf4b4e6f8d7d0b831b14eb2c14b82b93d741a257a96d1018f  legend-live.svg
4063be5d97150ce986d5525a7233c437c1ef214207d84240b4d92e3a78f95f71  legend-pocketed.svg
```
