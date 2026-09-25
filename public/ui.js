// Набор кусков интерфейса vault.
//
// Весь DOM строится здесь и только через textContent. innerHTML в подписывающем
// origin — единственное место, где может завестись XSS, а данные сюда приходят
// с чейна и от app. Поэтому его нет нигде, включая иконки: SVG собирается
// через createElementNS, а не строкой.
//
// Язык форм — тот же, что в app: карточка на чуть осветлённом фоне, строка с
// иконкой слева, мятный акцент, ничего светящегося. Главное — крупно и сверху,
// техническое — мелко, свёрнуто или на следующем шаге.

const SVG = 'http://www.w3.org/2000/svg'

export const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props)
  for (const child of children) if (child) node.append(child)
  return node
}

/** @param {string[]} paths — атрибуты d, ничего больше в иконку не попадает. */
export function icon(paths, size = 14) {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', size)
  svg.setAttribute('height', size)
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')

  for (const d of paths) {
    const path = document.createElementNS(SVG, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }

  return svg
}

export const ICONS = {
  lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  key: [
    'M2.6 17.4A2 2 0 0 0 2 18.8V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.2a2 2 0 0 0 1.4-.6l.8-.8a6.5 6.5 0 1 0-4-4z',
    'M16.5 7.5h.01',
  ],
  check: ['M4 12l5 5L20 6'],
  alert: ['M12 8v5', 'M12 17h.01', 'M12 3 2 20h20L12 3z'],
  bolt: ['M13 2 4 14h7l-1 8 9-12h-7l1-8z'],
  // Auto sign: без конца и без клика.
  auto: ['M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4z'],
  out: ['M7 17 17 7', 'M8 7h9v9'],
  in: ['M17 7 7 17', 'M16 17H7V8'],
  chevron: ['M9 6l6 6-6 6'],
  chevronDown: ['M6 9l6 6 6-6'],
  link: [
    'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7',
    'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  ],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z', 'M9 12l2 2 4-4'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  left: ['M15 6l-6 6 6 6'],
  down: ['M12 5v14', 'M6 13l6 6 6-6'],
  plus: ['M12 5v14', 'M5 12h14'],
  phone: ['M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z', 'M11 18h2'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21a8 8 0 0 1 16 0'],
  plug: ['M9 3v6', 'M15 3v6', 'M6 9h12v3a6 6 0 0 1-12 0V9z', 'M12 18v3'],
  ban: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M6 6l12 12'],
  swap: ['M4 8h14', 'M15 5l3 3-3 3', 'M20 16H6', 'M9 13l-3 3 3 3'],
  download: ['M12 3v12', 'M7 11l5 5 5-5', 'M4 21h16'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
}

/** Знак Alcor Signer — кристалл Alcor с замком. Файл лежит рядом — наружу vault не ходит ни за чем. */
const logomark = () => el('img', { className: 'brand-mark', src: './signer-mark.svg', alt: '' })

/** Шапка: слева — чей это продукт, справа — на каком домене он открыт. */
/**
 * Шапка: слева «назад» (если экрану есть куда) и знак, справа — адрес.
 *
 * «Назад» живёт здесь, а не у заголовка: шапка не прокручивается, стрелка всегда
 * на месте, а заголовок экрана стоит по общей левой линии с содержимым.
 */
export const chrome = (back) =>
  el('header', {}, [
    el('div', { className: 'brand' }, [
      back ? backButton(back) : null,
      logomark(),
      el('span', { className: 'brand-name', textContent: 'Alcor Signer' }),
    ]),
    hostBadge(),
  ])

/**
 * Адрес окна — то, по чему человек проверяет, что это настоящий signer.
 *
 * Одной строкой, без рамки: мятный замок — тот же, что в знаке, — и адрес, в
 * котором ярко регистрируемая часть (`alcor.exchange`) и тихо поддомен. Так
 * браузеры учат читать адрес, и подделку вида `alcor.exchange.evil.io` видно сразу.
 */
function hostBadge() {
  const [sub, ...rest] = location.host.split('.')
  const address = rest.length
    ? [el('span', { className: 'host-sub', textContent: `${sub}.` }), el('span', { textContent: rest.join('.') })]
    : [el('span', { textContent: location.host })]

  return el('div', { className: 'host', title: 'Check this address before you sign' }, [icon(ICONS.lock, 11), ...address])
}

/** Заголовок экрана и строка под ним — что происходит и по чьей просьбе. */
/** Заголовок экрана. `title` — строка или части, среди которых может быть `accent(…)`. */
export const pageTitle = (title, sub) =>
  el('div', { className: 'page-head' }, [
    el('h1', { className: 'page-title' }, Array.isArray(title) ? title : [title]),
    sub ? el('div', { className: 'page-sub', textContent: sub }) : null,
  ])

/** Слово в заголовке, о котором экран, — имя аккаунта. Цветом, без подложки. */
export const accent = (text) => el('span', { className: 'accent', textContent: text })

/**
 * Стопка блоков с одним шагом между ними. Отступы — у стопки, не у блоков:
 * так соседние карточки не слипаются, а пустая стопка не оставляет дыры.
 */
export const stack = (children, { tight = false } = {}) =>
  el('div', { className: tight ? 'stack tight' : 'stack' }, children)

/** Блок с подписью-рубрикой над ним. */
export const section = (label, children) =>
  el('div', { className: 'section' }, [el('div', { className: 'section-label', textContent: label }), ...children])

export const note = (text) => el('p', { className: 'note', textContent: text })

/** Карточка. Внутри — строки: поля и плитки, ничего кроме. */
export const card = (children, className = '') =>
  el('div', { className: `card ${className}`.trim() }, children)

/** Строка «подпись — значение». Значение может быть узлом, а не только строкой. */
export function field(label, value) {
  const right =
    typeof value === 'string' || typeof value === 'number'
      ? el('span', { className: 'value', textContent: String(value) })
      : value

  return el('div', { className: 'field' }, [el('span', { className: 'label', textContent: label }), right])
}

/**
 * Строка-плитка: иконка слева, заголовок с пояснением, довесок справа.
 *
 * Основной кирпич экранов. С `onclick` становится кнопкой — так устроен выбор
 * аккаунта: человек жмёт на строку целиком, а не выцеливает ссылку.
 */
export function tile({ icon: paths, tone = '', title, sub, aside, onclick, className = '' }) {
  const body = el('div', { className: 'tile-body' }, [
    typeof title === 'string' ? el('div', { className: 'tile-title', textContent: title }) : title,
    typeof sub === 'string' ? el('div', { className: 'tile-sub', textContent: sub }) : sub ? el('div', { className: 'tile-sub' }, [sub]) : null,
  ])

  const children = [
    paths ? el('div', { className: `tile-icon ${tone}`.trim() }, [icon(paths, 16)]) : null,
    body,
    aside ? el('div', { className: 'tile-aside' }, [aside]) : null,
  ]

  return onclick
    ? el('button', { className: `tile ${className}`.trim(), onclick }, children)
    : el('div', { className: `tile ${className}`.trim() }, children)
}

/**
 * Что будет по шагам: номер, действие, пояснение.
 *
 * Для экранов, где человек делает часть здесь, часть в другом окне: без
 * порядка он не понимает, где он сейчас и что его ждёт дальше.
 */
export const steps = (items) =>
  el(
    'ol',
    { className: 'steps' },
    items.map(([title, sub], i) =>
      el('li', { className: 'step' }, [
        el('span', { className: 'step-n', textContent: String(i + 1) }),
        el('div', { className: 'step-body' }, [
          el('div', { className: 'step-title', textContent: title }),
          sub ? el('div', { className: 'step-sub', textContent: sub }) : null,
        ]),
      ])
    )
  )

/**
 * Строка-тумблер с пояснением, которое меняется вместе с ним.
 *
 * Под тумблером всегда написано, что будет при текущем положении, — не
 * название настройки, а её последствие: «каждая сделка спросит Face ID».
 * Иначе человек щёлкает туда-сюда и не понимает, что поменялось.
 *
 * Возвращает строку, а не карточку: соседние настройки живут в одной карточке.
 */
export function switchRow({ icon: paths, title, on, onText, offText, onchange }) {
  const sub = el('span', { textContent: on ? onText : offText })
  let row

  const node = toggle(on, async () => {
    on = !on
    node.classList.toggle('on', on)
    node.ariaPressed = String(on)
    row.classList.toggle('on', on)
    sub.textContent = on ? onText : offText
    onchange(on)
  })

  row = tile({ icon: paths, tone: 'mint', title, sub, aside: node, className: `switch-row${on ? ' on' : ''}` })
  return row
}

/** Тумблер. Состояние держит вызывающий: здесь только вид и клик. */
function toggle(on, onclick) {
  const node = el('button', {
    className: `switch${on ? ' on' : ''}`,
    type: 'button',
    ariaPressed: String(on),
    onclick: async () => {
      node.disabled = true
      try {
        await onclick()
      } finally {
        node.disabled = false
      }
    },
  })

  return node
}

/**
 * Длинный идентификатор: середина скрыта, клик копирует целиком.
 *
 * Полное значение лежит в title — это тоже текст, не разметка.
 */
export function mono(value, { copy = true } = {}) {
  const node = el('span', {
    className: 'mono' + (copy ? ' copyable' : ''),
    textContent: shorten(value),
    title: copy ? value : '',
  })

  if (copy) {
    node.onclick = async () => {
      await navigator.clipboard.writeText(value)
      node.textContent = 'copied'
      node.classList.add('copied')
      setTimeout(() => {
        node.textContent = shorten(value)
        node.classList.remove('copied')
      }, 900)
    }
  }

  return node
}

const shorten = (value) => (value.length > 26 ? `${value.slice(0, 14)}…${value.slice(-8)}` : value)

/** Плашка. Опасное должно выглядеть опасно, а не курсивом. */
export const banner = (kind, text) =>
  el('div', { className: `banner ${kind}` }, [
    icon(kind === 'danger' || kind === 'warn' ? ICONS.alert : ICONS.check, 15),
    el('span', { textContent: text }),
  ])

/** Ход дела: нода думает, Face ID ждёт пальца. Живёт под кнопками. */
export const status = (text) =>
  el('div', { className: 'status' }, [el('div', { className: 'spinner' }), el('span', { textContent: text })])

/** Заглушка на месте значения, которое ещё едет с чейна. */
export function skeleton(width, height) {
  const node = el('span', { className: 'skel' })
  node.style.width = `${width}px`
  if (height) node.style.height = `${height}px`
  return node
}

/**
 * Пары цветов для аватаров — подобраны руками под чёрный фон. Случайный hue
 * даёт грязно-жёлтые и болотные круги. Каждая пара — своё семейство оттенков,
 * чтобы соседние аккаунты не сливались; чистой мяты нет — она у «Fast».
 */
const AVATAR_PAIRS = [
  ['#4f8cff', '#7ab8ff'],
  ['#7c6cf2', '#b08cff'],
  ['#e0609f', '#f59ac0'],
  ['#f08a4b', '#f6c26b'],
  ['#1fb5a8', '#5ee0c8'],
  ['#7cc95a', '#c3e67a'],
  ['#e25c6a', '#f29a86'],
  ['#3aa0d8', '#6fe0f0'],
]
const AVATAR_ANGLES = [135, 200, 250, 315]

/**
 * FNV-1a с перемешиванием в конце (fmix32 из MurmurHash3): стабильный хеш
 * строки. Без перемешивания похожие имена — `avral3`, `avral.alcor` — падают
 * в одну пару. Не для безопасности — для цвета.
 */
function hashName(name) {
  let hash = 0x811c9dc5
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 0x01000193)
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b)
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35)
  return (hash ^ (hash >>> 16)) >>> 0
}

/**
 * Аватар аккаунта — градиент, выведенный из имени.
 *
 * Инициал не различает ничего: у половины аккаунтов первая буква одна и та же.
 * Цвет из имени одинаков везде, где это имя встречается, и различим в списке.
 * Без имени — пустой круг-заглушка.
 */
export function avatar(name) {
  const node = el('div', { className: name ? 'avatar' : 'avatar blank' })
  if (!name) return node

  const hash = hashName(name)
  const [from, to] = AVATAR_PAIRS[hash % AVATAR_PAIRS.length]
  node.style.background = `linear-gradient(${AVATAR_ANGLES[(hash >>> 8) % AVATAR_ANGLES.length]}deg, ${from}, ${to})`
  return node
}

/** Логотип сети из реестра — файл рядом, CSP `img-src 'self'`. */
export const chainLogo = (chain) => el('img', { className: 'chain-logo', src: chain.logo, alt: '' })

/** Метка-состояние в строке: «Fast», «owner». Мелко и справа, не спорит с именем. */
export function chip(text, paths, tone = '') {
  return el('span', { className: `chip ${tone}`.trim() }, [paths ? icon(paths, 11) : null, el('span', { textContent: text })])
}

/**
 * Выбор пути: крупная строка-кнопка в своей карточке.
 *
 * Для экранов, где путей несколько и они правда разные — «привязать кошелёк»,
 * «импортировать ключ», «завести новый». Пояснение говорит, чем путь кончится,
 * а не как он устроен.
 */
export const choice = ({ icon: paths, tone = '', title, sub, onclick }) =>
  el('button', { className: 'choice', type: 'button', onclick }, [
    el('div', { className: `tile-icon ${tone}`.trim() }, [icon(paths, 17)]),
    el('div', { className: 'tile-body' }, [
      el('div', { className: 'choice-title', textContent: title }),
      el('div', { className: 'tile-sub', textContent: sub }),
    ]),
    el('span', { className: 'choice-go' }, [icon(ICONS.chevron, 15)]),
  ])

/**
 * Сегменты: один из немногих вариантов, все на виду.
 *
 * @param {[unknown, string, (() => Node)?][]} items — значение, подпись и иконка
 */
export function segmented(items, current, onpick, { disabled = false, tip } = {}) {
  const node = el('div', { className: 'segmented', role: 'radiogroup' })

  const draw = () =>
    node.replaceChildren(
      ...items.map(([value, label, glyph]) => {
        const item = el(
          'button',
          {
            type: 'button',
            role: 'radio',
            disabled,
            ariaChecked: String(value === current),
            className: value === current ? 'on' : '',
            onclick: () => {
              current = value
              draw()
              onpick(value)
            },
          },
          [glyph?.(), label]
        )
        if (tip) tooltip(item, () => tip(value))
        return item
      })
    )

  draw()
  return node
}

/**
 * Подсказка при наведении мышью и при фокусе с клавиатуры.
 *
 * Живёт в `body` с `position: fixed`: раскрытая строка аккаунта обрезает всё,
 * что выходит за её края, и подсказка внутри неё осталась бы без верха. На
 * тач-экране наведения нет — там подсказки нет вовсе, объясняет строка под
 * переключателем. Клик прячет её: дальше идёт само действие.
 *
 * @param {() => Node[]} content
 */
let shownTip = null

const hideTip = () => {
  shownTip?.remove()
  shownTip = null
}

export function tooltip(target, content) {
  const show = () => {
    hideTip()
    shownTip = el('div', { className: 'tip', role: 'tooltip' }, content())
    document.body.append(shownTip)

    const anchor = target.getBoundingClientRect()
    const box = shownTip.getBoundingClientRect()
    const left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - box.width / 2), innerWidth - box.width - 8)
    const above = anchor.top - box.height - 8

    shownTip.style.left = `${left}px`
    shownTip.style.top = `${above >= 8 ? above : anchor.bottom + 8}px`
    shownTip.classList.add('shown')
  }

  target.addEventListener('pointerenter', (event) => event.pointerType === 'mouse' && show())
  target.addEventListener('focus', () => target.matches(':focus-visible') && show())
  for (const type of ['pointerleave', 'blur', 'click']) target.addEventListener(type, hideTip)
}

/** Плоский список строк-плиток без карточки: запасные ходы, редкие настройки. */
export const options = (tiles) => el('div', { className: 'options' }, tiles)

/** Мелкое текстовое действие внутри строки: «заменить ключ» под тумблером. */
export const inlineAction = (text, paths, onclick, variant = '') =>
  el('button', { className: `inline-action ${variant}`.trim(), type: 'button', onclick }, [
    paths ? icon(paths, 12) : null,
    el('span', { textContent: text }),
  ])

/** Экран об одном: первый запуск, отказ, тупик. Иконка, фраза, объяснение. */
export const state = ({ icon: paths, tone = '', title, text }) =>
  el('div', { className: 'state' }, [
    el('div', { className: `state-icon ${tone}`.trim() }, [icon(paths, 26)]),
    el('div', { className: 'state-title', textContent: title }),
    text ? el('div', { className: 'state-text', textContent: text }) : null,
  ])

/** Движение средств: сколько уходит и сколько приходит минимум. */
/** Движение средств: стрелка, «You send» и куда — слева, сумма справа. */
export const flow = ({ dir, label, amount, sub }) =>
  tile({
    icon: dir === 'out' ? ICONS.out : ICONS.in,
    tone: dir === 'out' ? 'pink' : 'mint',
    title: label,
    sub,
    aside: el('span', { className: 'flow-amount', textContent: amount }),
    className: `flow ${dir}`,
  })

/** Комиссию сети платит Alcor: знак, «Free» и кто платит — одной строкой, без плашки. */
export const feeCovered = () =>
  field(
    'network fee',
    el('span', { className: 'fee-covered' }, [
      el('img', { className: 'fee-mark', src: './signer-mark.svg', alt: '' }),
      el('span', { className: 'fee-free', textContent: 'Free' }),
      el('span', { className: 'fee-by', textContent: 'paid by Alcor' }),
    ])
  )

/**
 * Выбор из немногих вариантов, свёрнутый в строку: «подпись · значение ⌄».
 *
 * Клик по строке раскрывает под ней варианты с пояснениями, повторный —
 * сворачивает; стрелка разворачивается, и видно, что закрыть можно, ничего не
 * выбрав. Выбор сворачивает список сам. Выбрали не `current` — под строкой
 * `note(value)`, если он передан. `disabled` — только строка, без стрелки.
 *
 * @param {{ label: string, current: string, disabled?: boolean,
 *   options: { value: string, name: string, text: string, icon: string[], tone?: 'mint' | 'amber' }[],
 *   note?: (value: string) => string, onpick: (value: string) => unknown }} props
 */
export function modePicker({ label, options, current, disabled = false, note, onpick }) {
  let chosen = current
  const byValue = (value) => options.find((option) => option.value === value)

  const box = el('div', { className: 'mode' })
  const value = el('span', { className: 'mode-value' })
  const list = el('div', { className: 'mode-options', role: 'radiogroup' })
  const hint = el('p', { className: 'mode-note' })

  const head = disabled
    ? field(label, value)
    : el('button', { type: 'button', className: 'mode-head', ariaExpanded: 'false', onclick: () => setOpen(!box.classList.contains('open')) }, [
        el('span', { className: 'label', textContent: label }),
        value,
        el('span', { className: 'mode-chevron' }, [icon(ICONS.chevronDown, 13)]),
      ])

  function setOpen(open) {
    box.classList.toggle('open', open)
    head.ariaExpanded = String(open)
  }

  const option = ({ value: optionValue, name, text, icon: paths, tone = '' }) =>
    el(
      'button',
      {
        type: 'button',
        className: ['mode-option', tone, optionValue === chosen ? 'on' : ''].filter(Boolean).join(' '),
        role: 'radio',
        ariaChecked: String(optionValue === chosen),
        onclick: () => {
          chosen = optionValue
          draw()
          setOpen(false)
          onpick(optionValue)
        },
      },
      [
        el('span', { className: 'mode-option-icon' }, [icon(paths, 14)]),
        el('span', { className: 'mode-option-body' }, [
          el('span', { className: 'mode-option-name', textContent: name }),
          el('span', { className: 'mode-option-text', textContent: text }),
        ]),
        el('span', { className: 'mode-option-check' }, [icon(ICONS.check, 14)]),
      ]
    )

  function draw() {
    const { name, icon: paths, tone = '' } = byValue(chosen)
    value.className = `mode-value ${tone}`.trim()
    value.replaceChildren(icon(paths, 12), el('span', { textContent: name }))
    list.replaceChildren(...options.map(option))
    // Пустая строка от `note` — сказать нечего, и пустой строки на экране нет.
    const text = chosen === current ? '' : (note?.(chosen) ?? '')
    hint.hidden = !text
    hint.textContent = text
  }

  box.append(head, el('div', { className: 'mode-panel' }, [el('div', { className: 'mode-panel-clip' }, [list])]), hint)
  draw()
  return box
}

/**
 * Кто подписывает: аватар, имя, сеть и permission. Справа — чем подтверждается.
 * Имя крупно: это главное, что надо сверить перед подписью.
 */
export const signerRow = ({ name, permission, network, level }) =>
  el('div', { className: 'signer' }, [
    avatar(name),
    el('div', { className: 'tile-body' }, [
      el('div', { className: 'signer-name', textContent: name }),
      el('div', { className: 'signer-sub' }, [chainLogo(network), el('span', { textContent: `${network.name} · ${permission}` })]),
    ]),
    level,
  ])

export function button(text, onclick, variant = '') {
  return el('button', {
    className: variant,
    textContent: text,
    onclick: async (event) => {
      const node = event.currentTarget
      node.disabled = true
      try {
        await onclick()
      } finally {
        node.disabled = false
      }
    },
  })
}

/** «Назад» — стрелка в шапке, перед знаком. Esc делает то же (см. app.js). */
const backButton = (onclick) =>
  el('button', { className: 'back', type: 'button', ariaLabel: 'Back', title: 'Back (Esc)', onclick }, [icon(ICONS.left, 16)])

/**
 * Нижняя панель действий — всегда на виду, не уезжает со скроллом.
 *
 * `buttons` — крупные, обычно одна главная. `links` — строка мелких текстовых
 * действий под ней: назад, отмена, запасной ход. Им нужно быть видимыми, но
 * не нужно спорить с главной кнопкой.
 *
 * @param {HTMLElement[]} buttons
 * @param {[string, () => unknown, string?][]} links — текст, действие, вариант ('danger')
 */
export function actionBar(buttons, links = []) {
  const row = links.length
    ? el(
        'div',
        { className: 'action-links' },
        links.flatMap(([text, onclick, variant], i) => [
          i ? el('span', { className: 'sep', textContent: '·' }) : null,
          button(text, onclick, variant),
        ])
      )
    : null

  return el('div', { className: 'actions' }, [...buttons, row])
}

/** Свёрнутая подробность на нативных details — без JS и без состояния. */
export const disclosure = (title, children) =>
  el('details', {}, [el('summary', { textContent: title }), stack(children)])

/**
 * Экшен в сыром виде: «контракт::экшен», кто подписывает, поля таблицей.
 *
 * Значения слева и моноширинно: memo и JSON бывают длинными, и прижатые
 * вправо они сжимались в узкий столбик.
 *
 * @param {{ contract: string, name: string, by: string, data: [string, string][] }} action — из `describe`
 */
export const rawAction = ({ contract, name, by, data }) =>
  el('div', { className: 'raw-action' }, [
    el('div', { className: 'raw-head' }, [
      el('span', { className: 'raw-call' }, [
        contract,
        el('span', { className: 'raw-sep', textContent: '::' }),
        name,
      ]),
      el('span', { className: 'raw-by', textContent: by }),
    ]),
    data.length
      ? el(
          'div',
          { className: 'raw-fields' },
          data.flatMap(([key, value]) => [
            el('span', { className: 'raw-key', textContent: key }),
            el('span', { className: value ? 'raw-value' : 'raw-value empty', textContent: value || 'empty' }),
          ])
        )
      : null,
  ])

/** Строка-перечисление: один адрес, один ключ — без подписи слева. */
export const line = (text) => el('div', { className: 'line', textContent: text })

/** Ссылка наружу. `noreferrer` — чтобы обозреватель не получил ссылку на это окно. */
export const link = (text, href) =>
  el('a', { className: 'link', href, target: '_blank', rel: 'noreferrer noopener', textContent: text })

/** Ссылка наружу в виде главной кнопки — когда следующий шаг на другом сайте. */
export const linkButton = (text, href) =>
  el('a', { className: 'button primary', href, target: '_blank', rel: 'noreferrer noopener' }, [
    el('span', { textContent: text }),
    icon(ICONS.external, 14),
  ])

/**
 * 24 слова: пронумерованной сеткой, по три в ряд.
 *
 * Номер при каждом слове — не украшение: переписывают столбиком, и перепутанный
 * порядок даёт чужой корень так же верно, как опечатка.
 */
export const wordGrid = (words) =>
  el('div', { className: 'secret' }, [
    el(
      'ol',
      { className: 'word-grid' },
      words.map((word) => el('li', {}, [el('span', { className: 'word', textContent: word })]))
    ),
    copyButton(words.join(' ')),
  ])

function copyButton(value) {
  const copy = el('button', { className: 'secret-copy', type: 'button' }, [
    icon(ICONS.copy, 13),
    el('span', { textContent: 'Copy' }),
  ])

  copy.onclick = async () => {
    await navigator.clipboard.writeText(value)
    copy.replaceChildren(icon(ICONS.check, 13), el('span', { textContent: 'Copied' }))
    copy.classList.add('done')
    setTimeout(() => {
      copy.replaceChildren(icon(ICONS.copy, 13), el('span', { textContent: 'Copy' }))
      copy.classList.remove('done')
    }, 1200)
  }

  return copy
}

/**
 * Поле ввода для секретов: слов и приватного ключа.
 *
 * Ни автозаполнения, ни проверки орфографии, ни автокапитализации: словарь
 * браузера и менеджер паролей не должны увидеть то, что сюда вставляют.
 */
/**
 * Поле для секрета: приватного ключа или 24 слов.
 *
 * Вставленный секрет стирается из буфера обмена: там он живёт дольше, чем
 * нужен, его видит любое приложение с доступом к буферу, и его легко вставить
 * потом не туда. История буфера (менеджеры буфера, Windows) — вне досягаемости.
 * Вставка — жест пользователя, поэтому запись в буфер браузер разрешает;
 * `onCleared` узнаёт, что стёрлось, а не вышло — молчит: поле работает и так.
 */
export function secretInput({ placeholder, multiline = false, onCleared = () => {} }) {
  const node = el(multiline ? 'textarea' : 'input', {
    className: 'field-input',
    placeholder,
    autocomplete: 'off',
    spellcheck: false,
  })

  node.setAttribute('autocapitalize', 'off')
  node.setAttribute('autocorrect', 'off')
  node.setAttribute('data-1p-ignore', '')
  node.setAttribute('data-lpignore', 'true')
  if (multiline) node.rows = 4
  else node.type = 'password'

  node.addEventListener('paste', () => {
    navigator.clipboard
      ?.writeText('')
      .then(onCleared)
      .catch(() => {})
  })

  return node
}

/**
 * Подтверждение поверх экрана — нативный `<dialog>`: фон затемнён, фокус
 * внутри, Esc и клик мимо окна — «нет». Для выбора с последствиями, который
 * легко сделать мимоходом одним тапом по табу.
 *
 * @returns {Promise<boolean>} true — подтвердили
 */
export function confirmDialog({ icon: paths, tone = '', title, text, confirm, cancel = 'Not now' }) {
  return new Promise((resolve) => {
    const dialog = el('dialog', { className: 'confirm' })
    const answer = (value) => {
      resolve(value)
      dialog.close()
    }

    dialog.append(
      el('div', { className: 'confirm-body' }, [
        paths ? el('span', { className: `confirm-icon ${tone}`.trim() }, [icon(paths, 18)]) : null,
        el('h2', { className: 'confirm-title', textContent: title }),
        el('p', { className: 'confirm-text', textContent: text }),
        el('div', { className: 'confirm-actions' }, [
          el('button', { type: 'button', className: 'primary', textContent: confirm, onclick: () => answer(true) }),
          el('button', { type: 'button', className: 'quiet', textContent: cancel, onclick: () => answer(false) }),
        ]),
      ])
    )

    // Esc закрывает окно сам; клик по затемнению попадает в сам <dialog> —
    // содержимое лежит во внутреннем блоке.
    dialog.addEventListener('close', () => {
      resolve(false)
      dialog.remove()
    })
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) answer(false)
    })

    document.body.append(dialog)
    dialog.showModal()
  })
}

/** Список последствий. Не плашка на всё — по строке на каждое, чтобы читалось. */
export const consequences = (items) =>
  el('ul', { className: 'consequences' }, items.map((text) => el('li', { textContent: text })))

/**
 * Галка: «я записал», «этот аккаунт — да».
 *
 * `sub` — что значит выбор, `aside` — метка справа (permission, сеть).
 */
export function checkbox(label, onchange, { checked = false, sub, aside } = {}) {
  const box = el('span', { className: 'check-box' }, [icon(ICONS.check, 12)])
  const node = el('label', { className: `check${checked ? ' on' : ''}` }, [
    box,
    el('span', { className: 'check-body' }, [
      el('span', { className: 'check-title', textContent: label }),
      sub ? el('span', { className: 'check-sub', textContent: sub }) : null,
    ]),
    aside ?? null,
  ])

  node.onclick = () => {
    node.classList.toggle('on')
    onchange(node.classList.contains('on'))
  }

  return node
}

/**
 * Ошибка: что это значит, и что ровно ответила нода.
 *
 * Заголовок — для человека, строка под ним — для того, кто пойдёт разбираться.
 * Второе не прячется: объяснение покрывает не всякий ассерт, и когда не
 * покрывает, точный текст — единственное, по чему вообще можно что-то понять.
 */
export function errorBox(title, detail, kind = 'danger') {
  return el('div', { className: `banner ${kind}` }, [
    icon(ICONS.alert, 15),
    el('div', {}, [
      el('div', { textContent: title }),
      detail && detail !== title ? el('div', { className: 'banner-detail', textContent: detail }) : null,
    ]),
  ])
}
