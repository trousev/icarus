// Словарь строк панели: язык интерфейса — отдельная настройка от языка ответов.
//
// Зачем отдельный файл. До этого все подписи панели были русскими литералами,
// разбросанными по серверной разметке (ui.ts, chat-ui.ts) и по клиентским скриптам.
// Пока язык интерфейса не настраивался, это было незаметно; с двумя языками такой
// литерал — это строка, которую забыли перевести, и найти её можно только глазами.
// Здесь же видно, каких строк не хватает: тип PanelStrings обязывает EN и RU иметь
// один и тот же набор ключей, а тест проверяет, что ни одна строка не пустая.
//
// Граница перевода описана в PR: переводится оболочка панели (навигация, кнопки,
// пустые состояния, подписи настроек). НЕ переводятся память, скиллы, имена файлов,
// код, цитаты и примеры реплик, которые уезжают агенту, — это содержимое и контекст,
// а не интерфейс (см. memoryLanguageNote и specs/ru-language.md).
import type { UiLanguage } from '../profile.ts';

/** Формы слова для счётчиков: в русском их три, в английском хватает двух. */
export type WordForms = { one: string; few: string; many: string };

export type PanelStrings = {
  /** Код языка: по нему клиент выбирает правило множественного числа. */
  lang: UiLanguage;

  // ── оболочка: сайдбар, шапка, подписи полей ────────────────────────────────
  brandTagline: string;
  backToChat: string;
  backToPanel: string;
  settingsNavTitle: string;
  modelLabel: string;
  storageLabel: string;
  accessLabel: string;
  accessAdmin: string;
  agentActive: string;
  menu: string;
  closeMenu: string;
  panelWidth: string;
  filesPanelWidth: string;
  previewHeight: string;

  // ── разделы и их подписи ───────────────────────────────────────────────────
  sectionMemory: string;
  sectionSkills: string;
  sectionMcp: string;
  sectionKeys: string;
  sectionProfile: string;
  sectionArtifacts: string;
  scopePersonal: string;
  scopeShared: string;
  searchMemory: string;
  searchSkills: string;
  searchArtifacts: string;
  kickerMemory: string;
  kickerSkills: string;
  kickerSettings: string;
  aboutMemory: string;
  aboutProfile: string;
  aboutSkills: string;
  /** Почему память остаётся русской, даже когда панель на другом языке. */
  memoryLanguageNote: string;

  // ── память и скиллы: списки, пустые состояния, кнопки ──────────────────────
  headingFiles: string;
  headingSkills: string;
  loading: string;
  readingFolder: string;
  newSkill: string;
  tabNotes: string;
  tabSkill: string;
  tabHistory: string;
  download: string;
  save: string;
  deleteLabel: string;
  clearSelection: string;
  revert: string;
  close: string;
  cancel: string;
  confirm: string;
  confirmDelete: string;
  confirmRevert: string;
  confirmRemove: string;
  emptyPickFile: string;
  emptyMemory: string;
  emptyNoResults: string;
  emptyNoSkills: string;
  emptyPickSkill: string;
  emptyHistoryFile: string;
  emptyHistorySkills: string;
  emptyImage: string;
  emptyDiff: string;
  downloadFailedPrefix: string;
  imageMeta: string;
  notSaved: string;
  changedOn: string;
  cappedNote: string;
  filesWord: WordForms;
  skillsWord: WordForms;
  entriesWord: WordForms;
  bytesShort: string;
  kilobytesShort: string;
  megabytesShort: string;
  /** «{n} {word}» — общий шаблон счётчика. */
  countLabel: string;
  /** «Поиск» — заголовок открытых результатов. */
  searchTitle: string;
  /** «{query} · найдено: {n}» — подпись результатов поиска. */
  searchMeta: string;
  /** «Выбрано {n} из {total}». */
  selectedOf: string;
  /** «Выберите строки, чтобы удалить · всего {n} {word}». */
  selectRows: string;
  /** «Удалить ({n})». */
  deleteCount: string;
  /** «Убрать из памяти {what}?» — {what} собирается из entryOne/entryManyPrefix. */
  removeMemoryPrompt: string;
  entryOne: string;
  entryManyPrefix: string;
  deleteSkillPrompt: string;
  revertCommitPrompt: string;

  // ── скилл: редактор ────────────────────────────────────────────────────────
  skillIdeaLabel: string;
  skillIdeaPlaceholder: string;
  skillGeneratorHint: string;
  skillWrite: string;
  skillNewStatus: string;
  skillExistingStatus: string;
  skillIdeaTooShort: string;
  skillWriting: string;
  skillWritten: string;
  skillWrittenCheck: string;
  skillWriteFailed: string;
  skillNameLabel: string;
  skillNameHint: string;
  skillDescriptionLabel: string;
  skillDescriptionPlaceholder: string;
  skillDescriptionHint: string;
  skillBodyLabel: string;
  skillHidden: string;
  savedCommit: string;
  savedNoCommit: string;

  // ── настройки «Пользователь» ───────────────────────────────────────────────
  answerLanguageLabel: string;
  interfaceLanguageLabel: string;
  answerLanguageHint: string;
  interfaceLanguageHint: string;
  saving: string;
  savedAnswer: string;
  saveFailedPrefix: string;

  // ── чат: оболочка ──────────────────────────────────────────────────────────
  newChat: string;
  draftPreview: string;
  chatListEmpty: string;
  chatListEmptySearch: string;
  artifacts: string;
  settings: string;
  searchTitles: string;
  workspaceFiles: string;
  emptyHeading: string;
  emptyText: string;
  suggestions: string[];
  chatCommands: string;
  attachFile: string;
  inputPlaceholder: string;
  stop: string;
  stopAnswer: string;
  send: string;
  chatDisabledNote: string;
  composerHint: string;
  hideFiles: string;
  filesReading: string;
  chatUnavailablePlaceholder: string;
  readOnlyPlaceholder: string;
  readOnlyStatus: string;
  chatOffStatus: string;
  today: string;
  yesterday: string;
  thisWeek: string;
  earlier: string;

  // ── папки, архив и переименование разговора ────────────────────────────────
  folderNew: string;
  folderInbox: string;
  folderName: string;
  folderRename: string;
  folderDelete: string;
  folderDrop: string;
  folderEmpty: string;
  folderMoveTitle: string;
  folderNone: string;
  folderMenuNew: string;
  chatRename: string;
  chatMove: string;
  chatRenamePlaceholder: string;

  // ── канал последней реплики ────────────────────────────────────────────────
  viaPanel: string;
  /** «последняя реплика · {name}». */
  viaLast: string;
  viaTitle: string;
  telegramHint: string;
  busyInTelegram: string;
  busyInApi: string;
  busyInPanel: string;
  /** «Сейчас ответ идёт {where} — …». */
  busyInNote: string;
  /** «Этот разговор начат в {label}…». */
  lockedNote: string;
  lockedOther: string;

  // ── архив разговоров ───────────────────────────────────────────────────────
  archive: string;
  archiveTag: string;
  archiveAdd: string;
  archiveRestore: string;
  archiveRestoreTitle: string;
  archiveEmpty: string;
  archiveLoadFailed: string;
  archiveAddedNote: string;
  archiveRemovedNote: string;
  archiveRestoredNote: string;

  // ── очередь реплик ─────────────────────────────────────────────────────────
  /** «В очереди: {n}». */
  queueCount: string;
  queueHint: string;
  queueRemove: string;
  nowSend: string;
  nowTitle: string;

  // ── панель файлов workspace ────────────────────────────────────────────────
  filesSearch: string;
  filesSearchAria: string;
  filesSearching: string;
  filesNameMatch: string;
  /** «Просмотрено {n} файлов». */
  filesScanned: string;
  /** «, показаны первые {n} совпадений.». */
  filesFirstHits: string;
  filesTwoChars: string;
  filesEmptyFolder: string;
  /** «Показаны первые {n} файлов.». */
  filesFirstEntries: string;
  filesReadingFile: string;
  filesCopy: string;
  filesCopied: string;
  filesToChat: string;
  filesToChatTitle: string;
  filesDownload: string;
  filesTruncated: string;
  filesBinary: string;
  filesDeleteFolder: string;
  filesDeleteFile: string;
  /** «Папка «{name}» не пуста…». */
  filesFolderNotEmpty: string;
  /** «Папка «{name}» будет удалена.». */
  filesFolderWillDelete: string;
  /** «Файл «{path}» будет удалён…». */
  filesFileWillDelete: string;
  filesRemove: string;

  // ── MCP: страница и каталог рецептов ───────────────────────────────────────
  mcpKicker: string;
  mcpIntro: string;
  mcpAdd: string;
  mcpRecipes: string;
  mcpRecipesRule: string;
  mcpMyServers: string;
  mcpEmpty: string;
  /** «Серверов: {n} · включено {enabled} · готово {ready}». */
  mcpSummary: string;
  serversWord: WordForms;
  /** «проверено {date}». */
  mcpChecked: string;
  mcpRecipeWhen: string;
  mcpRecipeRequires: string;
  mcpRecipeSteps: string;
  mcpRecipeTrouble: string;
  /** «Проверено {date}». */
  mcpRecipeChecked: string;
  mcpRecipeDocs: string;
  mcpRecipeAdd: string;
  mcpRecipeNoKeys: string;
  mcpRecipeHeaderKey: string;
  /** «попросит {n} {word}». */
  mcpRecipeKeys: string;
  mcpRecipeEdit: string;
  /** «Добавить: {name}». */
  mcpRecipeAddNamed: string;
  keysWord: WordForms;

  // ── Задачи: расписание, по которому агент запускается сам ───────────────────
  /** «Задачи». */
  sectionTasks: string;
  tasksKicker: string;
  /** «Каждый запуск — новый разговор… Считается по поясу {tz}.» */
  tasksIntro: string;
  tasksNew: string;
  tasksEmpty: string;
  tasksPromptLabel: string;
  tasksPromptPlaceholder: string;
  tasksWhen: string;
  tasksTime: string;
  tasksDate: string;
  tasksWeekdays: string;
  tasksWorkspace: string;
  tasksEveryDay: string;
  tasksByWeekdays: string;
  tasksOnce: string;
  tasksCreate: string;
  tasksCancel: string;
  tasksCreated: string;
  tasksDeleted: string;
  tasksEnabled: string;
  tasksDisabled: string;
  tasksDelete: string;
  tasksDeleteArmed: string;
  /** «следующий запуск: {when}». */
  tasksNextRun: string;
  /** «последний: {when}». */
  tasksLastRun: string;
  /** «прошлый разговор: {title}». */
  tasksLastChat: string;
  /** «запуск не удался: {error}». */
  tasksError: string;
  tasksNoMoreRuns: string;
  tasksOn: string;
  tasksOff: string;
  tasksDone: string;
  /** «один раз {when}». */
  tasksRepeatOnce: string;
  /** «каждый день в {time}». */
  tasksRepeatDaily: string;
  /** «по {days} в {time}». */
  tasksRepeatWeekly: string;
  /** «каждую неделю в {time}». */
  tasksRepeatEveryWeek: string;
  tasksToday: string;
  tasksTomorrow: string;

  // ── скиллы: шаринг ─────────────────────────────────────────────────────────
  skillTagMine: string;
  skillTagShared: string;
  /** «от {owner}». */
  skillTagFrom: string;
  skillEnabled: string;
  skillDisabled: string;
  skillToggleOff: string;
  skillToggleOn: string;
  skillShareLabel: string;
  /** «Скилл принадлежит {owner}…». */
  skillOwnerBanner: string;
  /** «Только чтение: скилл принадлежит {owner}». */
  skillReadOnly: string;

  // ── выбор workspace в новом чате ──────────────────────────────────────────
  wsPickTitle: string;
  wsPickAbout: string;
  wsDefaultKind: string;
  wsPrivateKind: string;
  wsCustomKind: string;
  wsTalkDescription: string;
  wsPrivateDescription: string;
  wsCustomDescription: string;
  wsDeleteTitle: string;
  wsDeleteBody: string;
  wsNewTitle: string;
  wsNewKind: string;
  wsNewDescription: string;
  wsNewPlaceholder: string;
  wsNewHint: string;
  wsCreate: string;
  wsCancel: string;
  /** «НАЧАТЬ В «{name}»» — подпись над готовыми запросами. */
  wsStartIn: string;
  /** «Написать в «{name}»» — подсказка в поле ввода черновика. */
  wsInputPlaceholder: string;
  wsNameRequired: string;
  wsPrompts: string[];

  // ── общие отказы ───────────────────────────────────────────────────────────
  sessionExpired: string;
  errorPrefix: string;
};

const RU: PanelStrings = {
  lang: 'ru',

  brandTagline: 'агент · чат и настройки',
  backToChat: '← Назад в чат',
  backToPanel: '← В панель',
  settingsNavTitle: 'НАСТРОЙКИ',
  modelLabel: 'модель',
  storageLabel: 'хранилище',
  accessLabel: 'доступ',
  accessAdmin: 'админ',
  agentActive: 'Агент активен',
  menu: 'Меню',
  closeMenu: 'Закрыть меню',
  panelWidth: 'Ширина панели',
  filesPanelWidth: 'Ширина панели файлов',
  previewHeight: 'Высота предпросмотра',

  sectionMemory: 'Память',
  sectionSkills: 'Скиллы',
  sectionMcp: 'MCP',
  sectionKeys: 'Ключи',
  sectionProfile: 'Пользователь',
  sectionArtifacts: 'Артефакты',
  scopePersonal: 'Личная',
  scopeShared: 'Семейная',
  searchMemory: 'Поиск по памяти',
  searchSkills: 'Поиск по скиллам',
  searchArtifacts: 'Поиск по артефактам',
  kickerMemory: 'ПАМЯТЬ АГЕНТА',
  kickerSkills: 'СКИЛЛЫ АГЕНТА',
  kickerSettings: 'НАСТРОЙКИ',
  aboutMemory: 'Профиль, предпочтения и распорядок дня — то, что агент учитывает в первую очередь.',
  aboutProfile:
    'Две независимые настройки: язык, на котором Икар отвечает, и язык самой панели. ' +
    'Характер, шутки и память остаются прежними.',
  aboutSkills:
    'Скиллы Икара: он видит их имена и описания и читает инструкцию, когда задача совпала. ' +
    'Сохранённый скилл уезжает в следующий же ответ — идущий разговор не рвётся.',
  memoryLanguageNote:
    'Файлы памяти написаны по-русски: это язык контекста Икара, а не интерфейса. ' +
    'Переключение языка панели их не переводит.',

  headingFiles: 'ФАЙЛЫ',
  headingSkills: 'СКИЛЛЫ',
  loading: 'Читаю…',
  readingFolder: 'Читаю папку…',
  newSkill: 'Новый скилл',
  tabNotes: 'Записи',
  tabSkill: 'Скилл',
  tabHistory: 'История',
  download: 'Скачать',
  save: 'Сохранить',
  deleteLabel: 'Удалить',
  clearSelection: 'Снять выделение',
  revert: 'Откатить',
  close: 'Закрыть',
  cancel: 'отмена',
  confirm: 'подтвердить',
  confirmDelete: 'удалить',
  confirmRevert: 'откатить',
  confirmRemove: 'убрать',
  emptyPickFile: 'Выбери файл слева или найди что-нибудь поиском.',
  emptyMemory: 'Память пока пуста.',
  emptyNoResults: 'Ничего не нашлось.',
  emptyNoSkills: 'Скиллов пока нет: нажми «Новый скилл» и напиши первый.',
  emptyPickSkill: 'Выбери скилл слева или заведи новый: «Новый скилл».',
  emptyHistoryFile: 'Истории у этого файла пока нет.',
  emptyHistorySkills: 'Скиллы ещё не меняли: истории нет.',
  emptyImage: 'Картинка не открылась.',
  emptyDiff: 'пустой дифф',
  downloadFailedPrefix: 'файл не отдался: ',
  imageMeta: 'картинка',
  notSaved: 'ещё не сохранён',
  changedOn: 'изменён',
  cappedNote: 'Показаны не все записи: файл длиннее, чем помещается в панель.',
  filesWord: { one: 'файл', few: 'файла', many: 'файлов' },
  skillsWord: { one: 'скилл', few: 'скилла', many: 'скиллов' },
  entriesWord: { one: 'запись', few: 'записи', many: 'записей' },
  bytesShort: ' б',
  kilobytesShort: ' Кб',
  megabytesShort: ' Мб',
  countLabel: '{n} {word}',
  searchTitle: 'Поиск',
  searchMeta: '«{query}» · найдено: {n}',
  selectedOf: 'Выбрано {n} из {total}',
  selectRows: 'Выберите строки, чтобы удалить · всего {n} {word}',
  deleteCount: 'Удалить ({n})',
  removeMemoryPrompt: 'Убрать из памяти {what}?\n\nЭто коммит: вернуть можно откатом в истории.',
  entryOne: 'запись',
  entryManyPrefix: 'записей: ',
  deleteSkillPrompt:
    'Удалить скилл «{name}»?\n\nВместе с файлами бандла. Это коммит: вернуть можно откатом в истории.',
  revertCommitPrompt: 'Откатить коммит {hash}? Изменения вернутся обратным коммитом.',

  skillIdeaLabel: 'НАПИСАТЬ ЗА МЕНЯ',
  skillIdeaPlaceholder: 'Расскажи идею словами: «разбирать голосовые в текст и складывать в журнал»',
  skillGeneratorHint: 'Модель придумает имя, описание и инструкцию — останется проверить и сохранить.',
  skillWrite: 'Напиши за меня',
  skillNewStatus: 'Опиши идею — или заполни поля сам.',
  skillExistingStatus: 'Скилл уедет Икару после сохранения.',
  skillIdeaTooShort: 'Опиши идею хотя бы парой слов',
  skillWriting: 'Пишу… на это уходит до полутора минут',
  skillWritten: 'Написано · ',
  skillWrittenCheck: 'Написано · проверь и сохрани',
  skillWriteFailed: 'Не вышло: ',
  skillNameLabel: 'ИМЯ — КАТАЛОГ СКИЛЛА',
  skillNameHint:
    'Строчные латинские буквы, цифры и дефис: имя становится именем каталога, а в разговоре — командой <code>/skill:имя</code>.',
  skillDescriptionLabel: 'КОГДА ПРИМЕНЯТЬ',
  skillDescriptionPlaceholder: 'Что делает скилл и в какой момент его звать.',
  skillDescriptionHint:
    'По этой строке Икар и решает, что пора открыть инструкцию: без описания pi скилл пропустит.',
  skillBodyLabel: 'ИНСТРУКЦИЯ (SKILL.MD)',
  skillHidden: 'скрыть от модели: звать только командой <code>/skill:имя</code>',
  savedCommit: 'Сохранено · коммит ',
  savedNoCommit: 'Сохранено, но коммит не вышел — загляни в историю',

  answerLanguageLabel: 'ЯЗЫК ОТВЕТОВ',
  interfaceLanguageLabel: 'ЯЗЫК ИНТЕРФЕЙСА',
  answerLanguageHint: 'На этом языке Икар будет говорить с тобой — характер и память не меняются.',
  interfaceLanguageHint:
    'Язык кнопок и подписей панели. На язык ответов Икара не влияет: это отдельная настройка.',
  saving: 'Сохраняю…',
  savedAnswer: 'Сохранено. Следующий ответ будет на новом языке.',
  saveFailedPrefix: 'Не сохранилось: ',

  newChat: 'Новый чат',
  draftPreview: 'Расскажи, что нужно сделать.',
  chatListEmpty: 'Пока пусто. Начни новый чат.',
  chatListEmptySearch: 'Ничего не найдено.',
  artifacts: 'Артефакты',
  settings: 'Настройки',
  searchTitles: 'Поиск по названиям',
  workspaceFiles: 'Файлы workspace',
  emptyHeading: 'Чем займёмся?',
  emptyText:
    'Icarus помнит контекст из кластеров памяти и работает по своим скиллам. ' +
    'Начни с вопроса или готового запроса.',
  suggestions: [
    'Собери план на сегодня',
    'Что ты помнишь о Марке?',
    'Подготовь сводку по «Атласу»',
    'Напомни про дни рождения в июне',
  ],
  chatCommands: 'Команды чата',
  attachFile: 'Приложить файл',
  inputPlaceholder: 'Написать Icarus...',
  stop: 'Остановить',
  stopAnswer: 'Остановить ответ',
  send: 'Отправить',
  chatDisabledNote: 'чат недоступен: панель поднята без контейнера с pi',
  composerHint: 'Enter — отправить · Shift+Enter — перенос строки · / — команды',
  hideFiles: 'Скрыть файлы',
  filesReading: 'Читаю папку…',
  chatUnavailablePlaceholder: 'Чат недоступен…',
  readOnlyPlaceholder: 'Разговор только для чтения',
  readOnlyStatus: 'Только чтение',
  chatOffStatus: 'Чат выключен',
  today: 'Сегодня',
  yesterday: 'Вчера',
  thisWeek: 'На этой неделе',
  earlier: 'Раньше',

  // ── папки, архив и переименование разговора ────────────────────────────────
  folderNew: 'Папка',
  folderInbox: 'Входящие',
  folderName: 'Название папки',
  folderRename: 'Переименовать папку',
  folderDelete: 'Удалить папку',
  folderDrop: 'Перетащи чат сюда',
  folderEmpty: 'Здесь новые чаты. Перетащи их в папку.',
  folderMoveTitle: 'Переместить в',
  folderNone: 'Папок пока нет',
  folderMenuNew: '+ Новая папка…',
  chatRename: 'Переименовать разговор',
  chatMove: 'Переместить в папку',
  chatRenamePlaceholder: 'Новое имя разговора',

  // ── канал последней реплики ────────────────────────────────────────────────
  viaPanel: 'панель',
  viaLast: 'последняя реплика · {name}',
  viaTitle: 'Разговор общий: панель и Telegram пишут в одну сессию',
  telegramHint: 'Разговор общий с Telegram: ответ появится здесь и в истории — в Telegram я его не отправлю.',
  busyInTelegram: 'в Telegram',
  busyInApi: 'через API',
  busyInPanel: 'в панели',
  busyInNote:
    'Сейчас ответ идёт {where} — это тот же разговор и тот же ход. ' +
    'Дождись его и напиши ещё раз: второй ход я не начну.',
  lockedNote:
    'Этот разговор начат в {label}. Здесь он только для чтения — продолжить можно там, где он начат.',
  lockedOther: 'другом входе',

  // ── архив разговоров ───────────────────────────────────────────────────────
  archive: 'Архив',
  archiveTag: 'в архиве',
  archiveAdd: 'В архив',
  archiveRestore: 'Вернуть',
  archiveRestoreTitle: 'Вернуть из архива',
  archiveEmpty: 'Архив пуст.',
  archiveLoadFailed: 'Архив не загрузился: ',
  archiveAddedNote: 'Разговор в архиве. Из списка он ушёл, история и файлы остались на месте.',
  archiveRemovedNote: 'Разговор вернулся в список.',
  archiveRestoredNote: 'Разговор вернулся из архива.',

  // ── очередь реплик ─────────────────────────────────────────────────────────
  queueCount: 'В очереди: {n}',
  queueHint: 'доедет после текущего хода',
  queueRemove: 'Убрать из очереди',
  nowSend: 'Прервать и отправить',
  nowTitle: 'Прервать текущий ход и отправить это сообщение сейчас',

  // ── панель файлов workspace ────────────────────────────────────────────────
  filesSearch: 'Поиск по файлам',
  filesSearchAria: 'Поиск по файлам workspace',
  filesSearching: 'Ищу…',
  filesNameMatch: 'совпало имя файла',
  filesScanned: 'Просмотрено {n} файлов',
  filesFirstHits: ', показаны первые {n} совпадений.',
  filesTwoChars: 'Введи хотя бы два символа.',
  filesEmptyFolder: 'Папка пуста.',
  filesFirstEntries: 'Показаны первые {n} файлов.',
  filesReadingFile: 'Читаю файл…',
  filesCopy: 'Скопировать содержимое в буфер обмена',
  filesCopied: 'Скопировано',
  filesToChat: 'В чат',
  filesToChatTitle: 'Послать агенту: вставить путь в чат',
  filesDownload: 'Скачать файл',
  filesTruncated: 'Файл большой — показаны первые 256 КБ.',
  filesBinary: 'Двоичный файл — текстом его не показать.',
  filesDeleteFolder: 'Удалить папку?',
  filesDeleteFile: 'Удалить файл?',
  filesFolderNotEmpty:
    'Папка «{name}» не пуста. Вместе с ней удалятся все файлы внутри. Вернуть их будет нельзя.',
  filesFolderWillDelete: 'Папка «{name}» будет удалена.',
  filesFileWillDelete: 'Файл «{path}» будет удалён. Вернуть его будет нельзя.',
  filesRemove: 'Убрать',

  // ── MCP: страница и каталог рецептов ───────────────────────────────────────
  mcpKicker: 'ВНЕШНИЕ ИНСТРУМЕНТЫ',
  mcpIntro:
    'Серверы, которые добавляют Икару инструменты: списки задач, календарь, домашние дела. ' +
    'Включённый сервер Икар видит и может подключить; выключенный лежит здесь, ' +
    'но в разговор не попадает и контекст не занимает.',
  mcpAdd: 'Добавить MCP',
  mcpRecipes: 'Рецепты',
  mcpRecipesRule: 'Готовые серверы: команда, транспорт и нужные ключи уже известны.',
  mcpMyServers: 'МОИ СЕРВЕРЫ',
  mcpEmpty:
    'Пока пусто. Возьми рецепт выше, если готового сервера хватает, ' +
    'или нажми «Добавить MCP» — адрес и способ входа подскажет сам сервер.',
  mcpSummary: '{n} {word} · включено {enabled} · готово {ready}',
  serversWord: { one: 'сервер', few: 'сервера', many: 'серверов' },
  mcpChecked: 'проверено {date}',
  mcpRecipeWhen: 'Когда нужен.',
  mcpRecipeRequires: 'Что должно быть снаружи',
  mcpRecipeSteps: 'Что сделать',
  mcpRecipeTrouble: 'Если не поднялся',
  mcpRecipeChecked: 'Проверено {date}',
  mcpRecipeDocs: 'документация сервера',
  mcpRecipeAdd: 'Добавить',
  mcpRecipeNoKeys: 'без ключей',
  mcpRecipeHeaderKey: 'попросит ключ',
  mcpRecipeKeys: 'попросит {n} {word}',
  mcpRecipeEdit: 'Изменить MCP',
  mcpRecipeAddNamed: 'Добавить: {name}',
  keysWord: { one: 'ключ', few: 'ключа', many: 'ключей' },

  // ── Задачи: расписание, по которому агент запускается сам ───────────────────
  sectionTasks: 'Задачи',
  tasksKicker: 'РАСПИСАНИЕ АГЕНТА',
  tasksIntro:
    'Каждый запуск — новый разговор: агент получает промпт и работает в нём как обычно. ' +
    'Держать панель открытой не нужно, расписание считается по поясу {tz}.',
  tasksNew: 'Новая задача',
  tasksEmpty:
    'Пока пусто. Заведи задачу: напиши, что должен сделать агент, и выбери, когда запускать — ' +
    'результат появится новым разговором.',
  tasksPromptLabel: 'Что должен сделать агент',
  tasksPromptPlaceholder: 'Например: собери сводку по проекту X и приложи список рисков',
  tasksWhen: 'Когда',
  tasksTime: 'Время',
  tasksDate: 'Дата',
  tasksWeekdays: 'Дни недели',
  tasksWorkspace: 'Где работать',
  tasksEveryDay: 'Каждый день',
  tasksByWeekdays: 'По дням недели',
  tasksOnce: 'Один раз',
  tasksCreate: 'Создать',
  tasksCancel: 'Отмена',
  tasksCreated: 'Задача создана: агент запустится в свой час и откроет новый разговор.',
  tasksDeleted: 'Задача удалена.',
  tasksEnabled: 'Задача включена: следующий запуск уже назначен.',
  tasksDisabled: 'Задача выключена и не сработает.',
  tasksDelete: 'Удалить',
  tasksDeleteArmed: 'Удалить?',
  tasksNextRun: 'следующий запуск: {when}',
  tasksLastRun: 'последний: {when}',
  tasksLastChat: 'прошлый разговор: {title}',
  tasksError: 'запуск не удался: {error}',
  tasksNoMoreRuns: 'запусков больше нет',
  tasksOn: 'включена',
  tasksOff: 'выключена',
  tasksDone: 'отработала',
  tasksRepeatOnce: 'один раз {when}',
  tasksRepeatDaily: 'каждый день в {time}',
  tasksRepeatWeekly: 'по {days} в {time}',
  tasksRepeatEveryWeek: 'каждую неделю в {time}',
  tasksToday: 'сегодня',
  tasksTomorrow: 'завтра',

  // ── скиллы: шаринг ─────────────────────────────────────────────────────────
  skillTagMine: 'только мой',
  skillTagShared: 'поделился',
  skillTagFrom: 'от {owner}',
  skillEnabled: 'включён',
  skillDisabled: 'выключен',
  skillToggleOff: 'выключить',
  skillToggleOn: 'включить',
  skillShareLabel: 'поделиться с другими — приедет им выключенным',
  skillOwnerBanner:
    'Скилл принадлежит {owner}: его можно включить или выключить, но не править. ' +
    'Правки делает владелец, и они доезжают сюда сами.',
  skillReadOnly: 'Только чтение: скилл принадлежит {owner}',

  // ── выбор workspace в новом чате ──────────────────────────────────────────
  wsPickTitle: 'Выберите workspace',
  wsPickAbout:
    'Workspace — это рабочая папка агента. У каждого своя папка и свой AGENTS.md, поэтому ' +
    'поведение отличается. «Приватный» — исключение: папка только для чтения, а запись в память запрещена.',
  wsDefaultKind: 'по умолчанию',
  wsPrivateKind: 'только чтение',
  wsCustomKind: 'свой',
  wsTalkDescription: 'Своя рабочая папка и свой AGENTS.md. Память общая.',
  wsPrivateDescription: 'Приватный workspace: только чтение и никакой записи в память.',
  wsCustomDescription: 'Отдельная рабочая папка со своим AGENTS.md.',
  wsDeleteTitle: 'Удалить workspace?',
  wsDeleteBody:
    'Workspace «{name}» будет удалён. Диалоги останутся и вернутся в «{talk}». ' +
    'Рабочая папка на диске не затрагивается.',
  wsNewTitle: 'Новый workspace',
  wsNewKind: 'своя папка',
  wsNewDescription: 'Назовите пространство — оно получит отдельную рабочую папку.',
  wsNewPlaceholder: 'Название workspace',
  wsNewHint: 'Новый workspace получит отдельную рабочую папку со своим AGENTS.md.',
  wsCreate: 'Создать',
  wsCancel: 'Отмена',
  wsStartIn: 'НАЧАТЬ В «{name}»',
  wsInputPlaceholder: 'Написать в «{name}»',
  wsNameRequired: 'нужно название workspace',
  wsPrompts: [
    'Собери план на сегодня',
    'Что ты помнишь о Марке?',
    'Подготовь сводку по проекту «Атлас»',
    'Напомни про дни рождения в июне',
  ],

  sessionExpired: 'сессия входа истекла — обнови страницу',
  errorPrefix: 'ошибка: ',
};

const EN: PanelStrings = {
  lang: 'en',

  brandTagline: 'agent · chat and settings',
  backToChat: '← Back to chat',
  backToPanel: '← Back to panel',
  settingsNavTitle: 'SETTINGS',
  modelLabel: 'model',
  storageLabel: 'storage',
  accessLabel: 'access',
  accessAdmin: 'admin',
  agentActive: 'Agent active',
  menu: 'Menu',
  closeMenu: 'Close menu',
  panelWidth: 'Panel width',
  filesPanelWidth: 'Files panel width',
  previewHeight: 'Preview height',

  sectionMemory: 'Memory',
  sectionSkills: 'Skills',
  sectionMcp: 'MCP',
  sectionKeys: 'Keys',
  sectionProfile: 'Profile',
  sectionArtifacts: 'Artifacts',
  scopePersonal: 'Personal',
  scopeShared: 'Family',
  searchMemory: 'Search memory',
  searchSkills: 'Search skills',
  searchArtifacts: 'Search artifacts',
  kickerMemory: 'AGENT MEMORY',
  kickerSkills: 'AGENT SKILLS',
  kickerSettings: 'SETTINGS',
  aboutMemory: 'Profile, preferences and daily routine — the first things the agent takes into account.',
  aboutProfile:
    'Two independent settings: the language Icarus answers in and the language of the panel itself. ' +
    'Character, jokes and memory stay the same.',
  aboutSkills:
    'Icarus skills: it sees their names and descriptions and reads the instructions when a task matches. ' +
    'A saved skill applies to the very next answer — the ongoing conversation is not interrupted.',
  memoryLanguageNote:
    'Memory files are written in Russian: that is the language of Icarus’s context, not of the interface. ' +
    'Switching the panel language does not translate them.',

  headingFiles: 'FILES',
  headingSkills: 'SKILLS',
  loading: 'Reading…',
  readingFolder: 'Reading the folder…',
  newSkill: 'New skill',
  tabNotes: 'Notes',
  tabSkill: 'Skill',
  tabHistory: 'History',
  download: 'Download',
  save: 'Save',
  deleteLabel: 'Delete',
  clearSelection: 'Clear selection',
  revert: 'Revert',
  close: 'Close',
  cancel: 'cancel',
  confirm: 'confirm',
  confirmDelete: 'delete',
  confirmRevert: 'revert',
  confirmRemove: 'remove',
  emptyPickFile: 'Pick a file on the left or find something with search.',
  emptyMemory: 'Memory is empty so far.',
  emptyNoResults: 'Nothing found.',
  emptyNoSkills: 'No skills yet: hit “New skill” and write the first one.',
  emptyPickSkill: 'Pick a skill on the left or create one: “New skill”.',
  emptyHistoryFile: 'This file has no history yet.',
  emptyHistorySkills: 'Skills have not changed yet: no history.',
  emptyImage: 'The image did not open.',
  emptyDiff: 'empty diff',
  downloadFailedPrefix: 'the file did not download: ',
  imageMeta: 'image',
  notSaved: 'not saved yet',
  changedOn: 'changed',
  cappedNote: 'Not all entries are shown: the file is longer than the panel can display.',
  filesWord: { one: 'file', few: 'files', many: 'files' },
  skillsWord: { one: 'skill', few: 'skills', many: 'skills' },
  entriesWord: { one: 'entry', few: 'entries', many: 'entries' },
  bytesShort: ' B',
  kilobytesShort: ' KB',
  megabytesShort: ' MB',
  countLabel: '{n} {word}',
  searchTitle: 'Search',
  searchMeta: '“{query}” · found: {n}',
  selectedOf: 'Selected {n} of {total}',
  selectRows: 'Select lines to delete · {n} {word} in total',
  deleteCount: 'Delete ({n})',
  removeMemoryPrompt: 'Remove {what} from memory?\n\nThis is a commit: you can bring it back by reverting it in history.',
  entryOne: 'the entry',
  entryManyPrefix: 'entries: ',
  deleteSkillPrompt:
    'Delete the skill “{name}”?\n\nTogether with the bundle files. This is a commit: you can bring it back by reverting it in history.',
  revertCommitPrompt: 'Revert commit {hash}? The changes will come back as a reverse commit.',

  skillIdeaLabel: 'WRITE IT FOR ME',
  skillIdeaPlaceholder: 'Describe the idea in words: “turn voice messages into text and file them in the journal”',
  skillGeneratorHint: 'The model will come up with a name, description and instructions — you just review and save.',
  skillWrite: 'Write it for me',
  skillNewStatus: 'Describe the idea — or fill in the fields yourself.',
  skillExistingStatus: 'The skill reaches Icarus after you save it.',
  skillIdeaTooShort: 'Describe the idea in at least a couple of words',
  skillWriting: 'Writing… this takes up to a minute and a half',
  skillWritten: 'Written · ',
  skillWrittenCheck: 'Written · review and save',
  skillWriteFailed: 'Failed: ',
  skillNameLabel: 'NAME — THE SKILL DIRECTORY',
  skillNameHint:
    'Lowercase Latin letters, digits and hyphens: the name becomes the directory name and the command <code>/skill:name</code> in a conversation.',
  skillDescriptionLabel: 'WHEN TO USE IT',
  skillDescriptionPlaceholder: 'What the skill does and when to call it.',
  skillDescriptionHint:
    'This line is how Icarus decides when to open the instructions: without a description pi will skip the skill.',
  skillBodyLabel: 'INSTRUCTIONS (SKILL.MD)',
  skillHidden: 'hide from the model: call it only with <code>/skill:name</code>',
  savedCommit: 'Saved · commit ',
  savedNoCommit: 'Saved, but the commit did not go through — check the history',

  answerLanguageLabel: 'ANSWER LANGUAGE',
  interfaceLanguageLabel: 'INTERFACE LANGUAGE',
  answerLanguageHint: 'Icarus will talk to you in this language — character and memory stay the same.',
  interfaceLanguageHint:
    'The language of the panel buttons and labels. It does not affect the language Icarus answers in: that is a separate setting.',
  saving: 'Saving…',
  savedAnswer: 'Saved. The next answer will be in the new language.',
  saveFailedPrefix: 'Not saved: ',

  newChat: 'New chat',
  draftPreview: 'Tell me what needs doing.',
  chatListEmpty: 'Nothing here yet. Start a new chat.',
  chatListEmptySearch: 'Nothing found.',
  artifacts: 'Artifacts',
  settings: 'Settings',
  searchTitles: 'Search by title',
  workspaceFiles: 'Workspace files',
  emptyHeading: 'What shall we do?',
  emptyText:
    'Icarus remembers context from its memory clusters and works by its own skills. ' +
    'Start with a question or a ready-made prompt.',
  suggestions: [
    'Plan my day',
    'What do you remember about Mark?',
    'Draft a summary of Atlas',
    'Remind me about June birthdays',
  ],
  chatCommands: 'Chat commands',
  attachFile: 'Attach a file',
  inputPlaceholder: 'Message Icarus...',
  stop: 'Stop',
  stopAnswer: 'Stop the answer',
  send: 'Send',
  chatDisabledNote: 'chat unavailable: the panel is running without a pi container',
  composerHint: 'Enter — send · Shift+Enter — new line · / — commands',
  hideFiles: 'Hide files',
  filesReading: 'Reading the folder…',
  chatUnavailablePlaceholder: 'Chat unavailable…',
  readOnlyPlaceholder: 'This conversation is read-only',
  readOnlyStatus: 'Read only',
  chatOffStatus: 'Chat is off',
  today: 'Today',
  yesterday: 'Yesterday',
  thisWeek: 'This week',
  earlier: 'Earlier',

  // ── папки, архив и переименование разговора ────────────────────────────────
  folderNew: 'Folder',
  folderInbox: 'Inbox',
  folderName: 'Folder name',
  folderRename: 'Rename folder',
  folderDelete: 'Delete folder',
  folderDrop: 'Drag a chat here',
  folderEmpty: 'New chats land here. Drag them into a folder.',
  folderMoveTitle: 'Move to',
  folderNone: 'No folders yet',
  folderMenuNew: '+ New folder…',
  chatRename: 'Rename conversation',
  chatMove: 'Move to folder',
  chatRenamePlaceholder: 'New conversation name',

  // ── канал последней реплики ────────────────────────────────────────────────
  viaPanel: 'panel',
  viaLast: 'last message · {name}',
  viaTitle: 'One conversation: the panel and Telegram write into the same session',
  telegramHint: 'Shared conversation with Telegram: the answer appears here and in the history — I will not send it to Telegram.',
  busyInTelegram: 'in Telegram',
  busyInApi: 'via the API',
  busyInPanel: 'in the panel',
  busyInNote:
    'The answer is running {where} — it is the same conversation and the same turn. ' +
    'Wait for it and write again: I will not start a second turn.',
  lockedNote:
    'This conversation was started in {label}. Here it is read-only — you can continue where it was started.',
  lockedOther: 'another entry point',

  // ── архив разговоров ───────────────────────────────────────────────────────
  archive: 'Archive',
  archiveTag: 'archived',
  archiveAdd: 'Archive',
  archiveRestore: 'Restore',
  archiveRestoreTitle: 'Restore from archive',
  archiveEmpty: 'The archive is empty.',
  archiveLoadFailed: 'The archive did not load: ',
  archiveAddedNote: 'The conversation is archived. It left the list; its history and files stayed in place.',
  archiveRemovedNote: 'The conversation is back in the list.',
  archiveRestoredNote: 'The conversation is back from the archive.',

  // ── очередь реплик ─────────────────────────────────────────────────────────
  queueCount: 'Queued: {n}',
  queueHint: 'sent after the current turn',
  queueRemove: 'Remove from queue',
  nowSend: 'Interrupt and send',
  nowTitle: 'Interrupt the current turn and send this message now',

  // ── панель файлов workspace ────────────────────────────────────────────────
  filesSearch: 'Search files',
  filesSearchAria: 'Search workspace files',
  filesSearching: 'Searching…',
  filesNameMatch: 'the file name matched',
  filesScanned: 'Scanned {n} files',
  filesFirstHits: ', showing the first {n} matches.',
  filesTwoChars: 'Type at least two characters.',
  filesEmptyFolder: 'The folder is empty.',
  filesFirstEntries: 'Showing the first {n} files.',
  filesReadingFile: 'Reading the file…',
  filesCopy: 'Copy contents to clipboard',
  filesCopied: 'Copied',
  filesToChat: 'To chat',
  filesToChatTitle: 'Send to the agent: insert the path into the chat',
  filesDownload: 'Download file',
  filesTruncated: 'The file is large — the first 256 KB are shown.',
  filesBinary: 'A binary file cannot be shown as text.',
  filesDeleteFolder: 'Delete the folder?',
  filesDeleteFile: 'Delete the file?',
  filesFolderNotEmpty:
    'The folder “{name}” is not empty. All files inside will be deleted with it. They cannot be brought back.',
  filesFolderWillDelete: 'The folder “{name}” will be deleted.',
  filesFileWillDelete: 'The file “{path}” will be deleted. It cannot be brought back.',
  filesRemove: 'Remove',

  // ── MCP: страница и каталог рецептов ───────────────────────────────────────
  mcpKicker: 'EXTERNAL TOOLS',
  mcpIntro:
    'Servers that give Icarus extra tools: task lists, calendars, household chores. ' +
    'Icarus sees an enabled server and can connect it; a disabled one stays here ' +
    'but does not get into the conversation and takes no context.',
  mcpAdd: 'Add MCP',
  mcpRecipes: 'Recipes',
  mcpRecipesRule: 'Ready-made servers: the command, transport and required keys are already known.',
  mcpMyServers: 'MY SERVERS',
  mcpEmpty:
    'Nothing here yet. Take a recipe above if a ready-made server fits, ' +
    'or press “Add MCP” — the server itself will tell you the address and how to sign in.',
  mcpSummary: '{n} {word} · enabled {enabled} · ready {ready}',
  serversWord: { one: 'server', few: 'servers', many: 'servers' },
  mcpChecked: 'checked {date}',
  mcpRecipeWhen: 'When it is needed.',
  mcpRecipeRequires: 'What must exist outside',
  mcpRecipeSteps: 'What to do',
  mcpRecipeTrouble: 'If it did not start',
  mcpRecipeChecked: 'Checked {date}',
  mcpRecipeDocs: 'server documentation',
  mcpRecipeAdd: 'Add',
  mcpRecipeNoKeys: 'no keys',
  mcpRecipeHeaderKey: 'will ask for a key',
  mcpRecipeKeys: 'will ask for {n} {word}',
  mcpRecipeEdit: 'Edit MCP',
  mcpRecipeAddNamed: 'Add: {name}',
  keysWord: { one: 'key', few: 'keys', many: 'keys' },

  // ── Задачи: расписание, по которому агент запускается сам ───────────────────
  sectionTasks: 'Tasks',
  tasksKicker: 'AGENT SCHEDULE',
  tasksIntro:
    'Every run is a new conversation: the agent gets the prompt and works in it as usual. ' +
    'You do not need to keep the panel open; the schedule follows {tz}.',
  tasksNew: 'New task',
  tasksEmpty:
    'Nothing here yet. Add a task: write what the agent should do and pick when to run it — ' +
    'the result appears as a new conversation.',
  tasksPromptLabel: 'What the agent should do',
  tasksPromptPlaceholder: 'For example: gather a summary of project X and list the risks',
  tasksWhen: 'When',
  tasksTime: 'Time',
  tasksDate: 'Date',
  tasksWeekdays: 'Weekdays',
  tasksWorkspace: 'Where to work',
  tasksEveryDay: 'Every day',
  tasksByWeekdays: 'On weekdays',
  tasksOnce: 'Once',
  tasksCreate: 'Create',
  tasksCancel: 'Cancel',
  tasksCreated: 'Task created: the agent will start in its hour and open a new conversation.',
  tasksDeleted: 'Task deleted.',
  tasksEnabled: 'Task enabled: the next run is scheduled.',
  tasksDisabled: 'Task disabled and will not run.',
  tasksDelete: 'Delete',
  tasksDeleteArmed: 'Delete?',
  tasksNextRun: 'next run: {when}',
  tasksLastRun: 'last: {when}',
  tasksLastChat: 'previous conversation: {title}',
  tasksError: 'run failed: {error}',
  tasksNoMoreRuns: 'no more runs',
  tasksOn: 'enabled',
  tasksOff: 'disabled',
  tasksDone: 'done',
  tasksRepeatOnce: 'once on {when}',
  tasksRepeatDaily: 'every day at {time}',
  tasksRepeatWeekly: 'on {days} at {time}',
  tasksRepeatEveryWeek: 'every week at {time}',
  tasksToday: 'today',
  tasksTomorrow: 'tomorrow',

  // ── скиллы: шаринг ─────────────────────────────────────────────────────────
  skillTagMine: 'only mine',
  skillTagShared: 'shared',
  skillTagFrom: 'from {owner}',
  skillEnabled: 'enabled',
  skillDisabled: 'disabled',
  skillToggleOff: 'disable',
  skillToggleOn: 'enable',
  skillShareLabel: 'share with others — it arrives disabled for them',
  skillOwnerBanner:
    'The skill belongs to {owner}: you can enable or disable it, but not edit it. ' +
    'The owner makes the edits, and they arrive here on their own.',
  skillReadOnly: 'Read only: the skill belongs to {owner}',

  // ── выбор workspace в новом чате ──────────────────────────────────────────
  wsPickTitle: 'Choose a workspace',
  wsPickAbout:
    'A workspace is the agent’s working folder. Each has its own folder and its own AGENTS.md, ' +
    'so the behaviour differs. “Private” is the exception: the folder is read-only and writing to memory is forbidden.',
  wsDefaultKind: 'default',
  wsPrivateKind: 'read-only',
  wsCustomKind: 'custom',
  wsTalkDescription: 'Its own working folder and its own AGENTS.md. Memory is shared.',
  wsPrivateDescription: 'A private workspace: read-only, no writing to memory.',
  wsCustomDescription: 'A separate working folder with its own AGENTS.md.',
  wsDeleteTitle: 'Delete the workspace?',
  wsDeleteBody:
    'The workspace “{name}” will be deleted. Conversations stay and move back to “{talk}”. ' +
    'The working folder on disk is not touched.',
  wsNewTitle: 'New workspace',
  wsNewKind: 'own folder',
  wsNewDescription: 'Name the space — it will get its own working folder.',
  wsNewPlaceholder: 'Workspace name',
  wsNewHint: 'A new workspace gets its own working folder with its own AGENTS.md.',
  wsCreate: 'Create',
  wsCancel: 'Cancel',
  wsStartIn: 'START IN “{name}”',
  wsInputPlaceholder: 'Write in “{name}”',
  wsNameRequired: 'a workspace name is required',
  wsPrompts: [
    'Plan my day',
    'What do you remember about Mark?',
    'Draft a summary of the Atlas project',
    'Remind me about June birthdays',
  ],

  sessionExpired: 'the login session expired — reload the page',
  errorPrefix: 'error: ',
};

/** Строки интерфейса на языке человека. Неизвестный язык — русский. */
export function panelStrings(language: UiLanguage): PanelStrings {
  return language === 'en' ? EN : RU;
}

/** Язык интерфейса, для которого есть словарь. */
export function hasStrings(language: string): language is UiLanguage {
  return language === 'ru' || language === 'en';
}
