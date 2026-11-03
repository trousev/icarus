// Профиль человека: то, что он сам про себя настроил в панели.
//
// Пока здесь ровно одно поле — язык, на котором человек хочет слышать Икара.
// Язык не трогает личность: персона, память и шутки остаются как есть, меняется
// только язык реплик (см. раздел «Язык» в icarus.md).
//
// Файл лежит рядом с памятью человека (`<home>/profile.json`), а не в config.yaml:
// config.yaml — общий для всех, а язык у каждого свой. Читает его сервис: язык
// подставляется в AGENTS.md, который и уезжает в контейнер.
//
// Конфиг — не единственный источник: он даёт умолчание (`userLanguage`), профиль
// человека его перекрывает. Так у старой установки всё остаётся по-русски, пока
// человек сам не переключит.
import fs from 'node:fs';
import path from 'node:path';
import { userPaths, type IcarusConfig, type UserConfig } from './config.ts';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { log } from './log.ts';

/** Язык ответов. Пока два: русский и английский. */
export const LANGUAGES = ['ru', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = 'ru';

/** Как язык видит человек в панели — подписи кнопок, а не для печати вслух. */
export const LANGUAGE_LABELS: Record<Language, string> = {
  ru: 'Русский',
  en: 'English',
};

/** «по-русски» / «in English» — как язык называть в самом требовании. */
export const LANGUAGE_ADVERBS: Record<Language, string> = {
  ru: 'по-русски',
  en: 'in English',
};

/** Как называть язык прилагательным («английский текст»). */
export const LANGUAGE_ADJECTIVES: Record<Language, string> = {
  ru: 'русский',
  en: 'английский',
};

export type Profile = { language: Language };

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/**
 * Язык, который человек видит у себя. Профиль перекрывает умолчание конфига,
 * а тот — встроенный русский: отсутствующий или битый profile.json не повод
 * оставить человека без ответа.
 */
export function languageOf(config: IcarusConfig, user: UserConfig): Language {
  const stored = readProfile(config, user);
  if (stored !== undefined) return stored.language;
  return config.userLanguage ?? DEFAULT_LANGUAGE;
}

/** Путь профиля: рядом с памятью, чтобы «моё» лежало в одном месте. */
export function profilePath(config: IcarusConfig, user: UserConfig): string {
  return path.join(userPaths(config, user).icarus, 'profile.json');
}

export function readProfile(
  config: IcarusConfig,
  user: UserConfig,
): Profile | undefined {
  const file = profilePath(config, user);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    // Файл правят и руками, поэтому битый профиль — не авария: язык остаётся
    // прежним (умолчанием), а в логе видно, что именно не разобралось.
    log.warn('профиль человека не разобрался — язык останется из конфига', {
      user: user.id,
      file,
      error: String(error),
    });
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const language = (parsed as Record<string, unknown>).language;
  if (!isLanguage(language)) return undefined;
  return { language };
}

/** Записать язык. Каталог создаётся: панель может обогнать первый старт сервиса. */
export function writeProfile(config: IcarusConfig, user: UserConfig, profile: Profile): void {
  const file = profilePath(config, user);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringifyYaml({ language: profile.language }), { mode: 0o600 });
}
