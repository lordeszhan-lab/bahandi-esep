# Дизайн-система СВЕРКА — «Premium + Joy» (портативная)

> Снято с дизайн-системы Mentoria Hub и адаптировано под loss-intelligence продукт.
> Хребет, тактильность и no-slop-дисциплина — те же. Зелёный остаётся нашим house-цветом.
> Меняется **смысл цветного слоя** (риск + типы потерь вместо учебных категорий)
> и **сужается joy-слой** (это finance/forensics, а не consumer-EdTech).

## 0. Контракт (вставлять в КАЖДЫЙ build-промпт)
```
Follow СВЕРКА_DESIGN_SYSTEM.md exactly: white rounded-2xl cards on near-white canvas,
ONE green primary, neutral chrome, pastel-chip + saturated-ink-icon motif, soft shadows
(never borders/colored top-bars), Nunito + tabular-nums, lucide outline strokeWidth 1.6–1.75.
Colour layer = risk triad + loss-type categories, ≤3 accents per view, pastel is background only.
Joy layer (3D-ledge button, count-up, submit-celebration, streak) ONLY on frontline-capture and
the culture/leaderboard module — NEVER in review cockpit, control tower, investigations, Iiko
reconciliation, deductions, audit. Obey the no-AI-slop list. Respect prefers-reduced-motion.
```

## 1. Философия (одна строка)
**Минималистично, но красочно, мгновенно читаемо, никогда не шумно.** Бренд = целостность и честный учёт, поэтому зелёный — не неон, а «институциональный». Цвет работает, только когда несёт смысл (риск/тип потери), и всегда дисциплинирован.

## 2. Дисциплина двух цветов
- Каркас всегда = **нейтраль (fg/muted/border) + ровно один зелёный**. Больше в хроме ничего.
- Цвет живёт **только в data-слое** (риск-статусы, типы потерь, графики, геймификация) и рационирован: **≤3 акцента на экран**.
- Пастель — это **фон**. Текст/иконка на пастели — насыщенный ink того же семейства. Никогда «пастель на пастели», никогда чистый чёрный на цветной плашке.

## 3. Цветовые токены

### Бренд (зелёный) — наш, не трогаем. Бренд-зелёный = «approved/clean/recovered» намеренно один тон.
```
--brand        #16A34A   (dark: #22C55E)   primary CTA, активная навигация, «чисто/подтверждено»
--brand-strong #15803D                      3D-ledge «полка», pressed-состояние
--brand-soft   #DCFCE7                      фон зелёного чипа, success-баннер
--brand-ring   #86EFAC                      трек progress/risk-кольца
```

### Нейтрали (light)
```
--canvas    #F6F8F7   фон приложения (почти белый, чуть зелёно-серый)
--surface   #FFFFFF   карточки, поповеры
--surface-2 #F7F9F8   вложенные поверхности, шапки таблиц
--border    #E8ECEA   1px hairline (карта опирается на ТЕНЬ, не на бордер)
--fg        #1A1A1A   основной текст
--fg-muted  #6B7280   вторичный текст, лейблы
--fg-faint  #9CA3AF   плейсхолдеры, disabled
```

### Нейтрали (dark) — тёмный зелёно-серый, НЕ чёрный
```
--canvas #0B0F0E · --surface #14201C · --surface-2 #1B2A25 · --border #26352F
--fg #F3F5F4 · --fg-muted #9AA5A0
```

### Риск-триада (сердце control-продукта: кокпит, башня, бейджи, риск-скоры)
```
clean / approved / recovered → green  fill #16A34A · soft #DCFCE7 · ink #15803D
in-review / suspicious       → amber  fill #FF9600 · soft #FFF1E0 · ink #C2410C
fraud / rejected / danger    → red    fill #FF4B4B · soft #FEE2E2 · ink #B91C1C
synced / info                → blue   fill #1CB0F6 · soft #E0F4FE · ink #0369A1
```

### Карта типов потерь (6 reason-кодов) — мотив пастель-чип + ink-иконка.
**Красный сюда НЕ входит — он зарезервирован под фрод/danger.**
```
Технологический выход → slate    chip #EEF1F4 / ink #475569   (ожидаемая норма — намеренно тихий)
Брак качества         → blue     chip #E0F4FE / ink #0369A1   (поставщик/QC)
Случайное повреждение → orange   chip #FFF1E0 / ink #C2410C   (хранение/обучение)
Порча / срок          → teal     chip #D7F5F0 / ink #0F766E
Возврат гостя         → purple   chip #F6E9FF / ink #7E22CE
Бой                   → amber    chip #FFF6D6 / ink #A16207
```

### Готовый блок для `globals.css`
```css
:root{
  --brand:#16A34A; --brand-strong:#15803D; --brand-soft:#DCFCE7; --brand-ring:#86EFAC;
  --canvas:#F6F8F7; --surface:#FFFFFF; --surface-2:#F7F9F8; --border:#E8ECEA;
  --fg:#1A1A1A; --fg-muted:#6B7280; --fg-faint:#9CA3AF;
  --risk-clean:#16A34A;  --risk-clean-soft:#DCFCE7;  --risk-clean-ink:#15803D;
  --risk-watch:#FF9600;  --risk-watch-soft:#FFF1E0;  --risk-watch-ink:#C2410C;
  --risk-fraud:#FF4B4B;  --risk-fraud-soft:#FEE2E2;  --risk-fraud-ink:#B91C1C;
  --risk-info:#1CB0F6;   --risk-info-soft:#E0F4FE;   --risk-info-ink:#0369A1;
  --shadow-card:0 1px 2px rgba(16,24,20,.04), 0 8px 24px rgba(16,24,20,.06);
  --shadow-card-hover:0 2px 4px rgba(16,24,20,.06), 0 14px 32px rgba(16,24,20,.10);
  --radius-card:16px; --radius-ctl:12px; --radius-chip:14px;
}
[data-theme="dark"]{
  --brand:#22C55E; --canvas:#0B0F0E; --surface:#14201C; --surface-2:#1B2A25;
  --border:#26352F; --fg:#F3F5F4; --fg-muted:#9AA5A0;
}
/* Tailwind v4: продублировать те же значения в @theme как --color-brand и т.д. */
```
> Свап бренда: меняешь `--brand` (+`--brand-strong`/`-soft`/`-ring`) — переслинкуется вся система.

## 4. Типографика
- **Шрифт:** Nunito везде (400–900). Импорт из Google Fonts.
- **`font-variant-numeric: tabular-nums` на ВСЕХ числах** — деньги, %, количества, риск-скоры, счётчики. Критично для финансового продукта (цифры не «прыгают»).
- **Шкала:** display 40/800 · h1 32/800 · h2 24/800 · h3 20/700 · body 16/400 · small 14/400 · caption 13/400.
- **Eyebrow:** mono, UPPERCASE, `letter-spacing .08em`, `--fg-muted`.
- Заголовки — `--fg` (тёмный), не цветные. Цвет в тексте — только ink на пастельной плашке.

## 5. Радиусы / тени / elevation
- Карточки `rounded-2xl` (16px) · контролы/инпуты `rounded-xl` (12px) · кнопки/пилюли/чипы `rounded-full` · icon-чип squircle (~14px).
- Elevation = **мягкая тень** `--shadow-card`, НЕ бордер и НЕ цветная полоса сверху.
- `--border` (1px) — только как тонкий hairline на таблицах/разделителях, не как несущий контур карточки.
- На одной карточке НИКОГДА не стакаем тень + бордер + градиент.

## 6. Motion (две скорости)
- **Функциональная** (везде): `transition: all 150–200ms ease-out`. Hover карточки — `translateY(-2px)` + усиление тени до `--shadow-card-hover`. Hover кнопки — затемнение до `--brand-strong`. Появление списков — stagger fade-in 40–60ms на элемент.
- **Joy-спринг** (только joy-слой): пружина с лёгким overshoot (`cubic-bezier(.34,1.56,.64,1)`) на нажатии 3D-ledge и на «отправлено». Count-up для KPI-чисел.
- `prefers-reduced-motion: reduce` — отключаем lift/stagger/spring, оставляем мгновенные состояния.

## 7. Компоненты

**Primary-кнопка:** `bg:--brand; color:#fff; rounded-full; box-shadow:--shadow-card; hover:bg:--brand-strong; active:scale(.99)`. Ощутимый hover. Текст всегда белый (никогда белый текст без сплошной заливки — это баг «призрачной кнопки»).

**3D-ledge-кнопка (только frontline-capture / culture):** `box-shadow:0 4px 0 var(--brand-strong)` → `:active{ transform:translateY(4px); box-shadow:0 0 0 var(--brand-strong) }`. Делает подачу списания «вкусной» → adoption на точке.

**Вторичные:** outline-пилюля (`border:1px --border; bg:--surface`) и ghost (`hover:bg:--fg/6`). У всех — явный hover.

**Карточка:** `bg:--surface; rounded-2xl; box-shadow:--shadow-card; padding:20–24px; hover:translateY(-2px)+shadow-hover`. Без цветных полос.

**Selected-state (выбор reason-кода/опции):** выбрано = `bg:--brand; иконка/текст #fff; мягкий зелёный glow; translateY(-2px)`. Не выбрано = белая карточка с тонкой тенью.

**Пастельный reason-code чип:** squircle `bg:<chip>`; lucide outline `strokeWidth 1.6–1.75` цветом `<ink>`; рядом лейбл. Это сигнатурный мотив — НЕ цветная полоса во всю ширину.

**Risk-meter (расширение progress-кольца):** дуговой gauge на `--brand-ring`-треке, заливка по зонам green→amber→red под риск-скор/variance. Число в центре — tabular-nums.

**Status-пилл (состояния Iiko/воркфлоу):** `Synced`/`Approved` = `--risk-clean-soft`+`--risk-clean-ink`; `On hold` = `--risk-watch-*`; `Rejected`/`Fraud` = `--risk-fraud-*`; `Syncing` = `--risk-info-*`. Текст — ink того же семейства.

**KPI-карта (башня/дашборды):** muted-лейбл (13px) сверху, крупное число (24–32/800, tabular-nums) снизу, **count-up разрешён** (читается как premium-fintech, не по-детски). Тренд-стрелка цветом риск-семантики.

**Навигация/sidebar:** активный пункт = `bg:--brand-soft` + текст `--brand-strong` (или сплошной зелёный для основного CTA), иконки lucide outline.

## 8. Joy-матрица СВЕРКА (поверхность → joy да/нет)
| Поверхность | Joy | Что разрешено |
|---|---|---|
| Frontline-захват (подача + «отправлено») | **Да, лёгкий** | 3D-ledge primary, submit-celebration, count-up |
| Culture / leaderboard (опц.) | **Да** | streak честной отчётности, лидерборд |
| KPI-числа на любых дашбордах | Частично | только count-up |
| Review Cockpit | **Нет** | спокойно, плотно, premium-business |
| Variance / Control Tower | **Нет** | то же |
| Расследования, сверка Iiko, удержания, аудит | **Нет** | ноль конфетти/ledge/флеймов |

> Правило по умолчанию: СВЕРКА серьёзнее Mentoria. Сомневаешься — joy **выключен**.

## 9. No-AI-slop (жёсткие запреты)
- Нет фиолетовых градиентных кнопок.
- Нет неоновых glow-орбов и glassmorphism по умолчанию.
- Нет декоративных ✦/✨ и эмодзи-стикеров.
- Не стакать тень + бордер + градиент на одной карточке.
- Нет радужных цветных полос сверху карточек (главный slop-сигнал).
- ≤3 акцента на экран. Пастель — только фон.
- Нет fake-3D на всём (ledge — только на joy-кнопках).
- Зелёный «институциональный» `#16A34A`, не неон `#58CC02`.
- Маскота нет. Нужно тепло — абстрактные бренд-формы, не персонаж.
- Красный — только риск/danger, никогда как «категория».

## 10. A11y / контраст
- Каждая строка читаема, никакого «серого на сером».
- Цвет не единственный носитель смысла: риск-статус = цвет **+ иконка/лейбл** (для дальтоников и ч/б печати акта).
- Видимый focus-ring на всех интерактивных элементах.
- `prefers-reduced-motion` уважается.

## 11. Сборка (как у нас принято)
Не верстать UI руками — компоновать из shadcn/ui → Magic UI → 21st.dev → React Bits. Иконки — lucide outline. Всё fully rounded.
