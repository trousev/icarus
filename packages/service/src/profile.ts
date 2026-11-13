// The person's profile: what they configured about themselves in the panel.
//
// There are two independent language settings here. `language` is the language of REPLIES:
// it doesn't touch the persona (persona, memory, and jokes stay as they are), only the
// language of replies changes (see the «Язык» section in icarus.md) and goes into
// AGENTS.md. `uiLanguage` is the language of the panel INTERFACE: labels, buttons, empty
// states. All they share is that both live in the person's profile; they must be changed
// separately, otherwise an English-language interface will drag the replies along with it
// (or vice versa).
//
// The file lives next to the person's memory (`<home>/profile.json`) rather than in
// config.yaml: config.yaml is shared by everyone, while the language is each person's own.
// It's read by the service: the reply language is substituted into AGENTS.md, which is
// what goes into the container, and the interface language into the panel's strings.
//
// The config isn't the only source: it provides the default (`userLanguage`), and the
// person's profile overrides it. That way an old installation stays Russian until the
// person switches it themselves.
import fs from 'node:fs';
import path from 'node:path';
import { userPaths, type IcarusConfig, type UserConfig } from './config.ts';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { log } from './log.ts';

/**
 * Reply language. The code (`ru`, `en`) is the storage key: it lives in config.yaml and
 * in profile.json and NEVER gets into the prompt. In the requirement text the language is
 * named by its full name: «отвечай на языке: English».
 */
export const LANGUAGES = ['ru', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = 'ru';

/**
 * Panel interface language. The same codes as the reply language, but a separate list:
 * translating the interface into a language the replies don't have (or vice versa) is
 * a common thing, and a shared list would force adding languages in pairs.
 */
export const UI_LANGUAGES = ['ru', 'en'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

/**
 * The default is Russian: the panel has always been Russian, and an old profile.json
 * without `uiLanguage` must not switch the person's interface on the very first read.
 */
export const DEFAULT_UI_LANGUAGE: UiLanguage = 'ru';

/**
 * Everything the prompt prose needs — in a single dictionary per language.
 *
 * This way, rather than four parallel maps, for two reasons. First: maps drift apart —
 * a language is added to one and forgotten in another. Second: the forms for Russian
 * text differ and aren't derivable from the name («English», but «in English»;
 * «Русский», but «по-русски»), and keeping them next to the name is more honest than
 * inventing a general rule.
 *
 * A new language is one line here plus one line in LANGUAGES.
 */
type LanguageForms = {
  /** How the language is called to the person in the panel — the button label. */
  label: string;
  /** Full name for the prompt: «отвечай на языке: English». Only it goes into the text. */
  name: string;
  /** Adjective for Russian prose: «твой язык — английский». */
  adjective: string;
};

const FORMS: Record<Language, LanguageForms> = {
  ru: { label: 'Русский', name: 'Russian', adjective: 'русский' },
  en: { label: 'English', name: 'English', adjective: 'английский' },
};

/** Panel labels: how the person sees the language. */
export const LANGUAGE_LABELS: Record<Language, string> = Object.fromEntries(
  LANGUAGES.map((code) => [code, FORMS[code].label]),
) as Record<Language, string>;

/** The language's full name for the prompt. Only this goes into the requirement text. */
export function languageName(language: Language): string {
  return FORMS[language].name;
}

/** Forms for the requirement's Russian prose (see languageRule). */
export function languageForms(language: Language): LanguageForms {
  return FORMS[language];
}

export type Profile = { language: Language; uiLanguage: UiLanguage };

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

export function isUiLanguage(value: unknown): value is UiLanguage {
  return typeof value === 'string' && (UI_LANGUAGES as readonly string[]).includes(value);
}

/**
 * This person's interface language. The config doesn't participate here: `userLanguage`
 * is the default reply language, and the interface was always Russian before this setting.
 * A broken or unknown `uiLanguage` is also Russian, not a refusal to render the panel.
 */
export function uiLanguageOf(config: IcarusConfig, user: UserConfig): UiLanguage {
  const stored = readProfile(config, user);
  return stored?.uiLanguage ?? DEFAULT_UI_LANGUAGE;
}

/**
 * The language the person sees for themselves. The profile overrides the config default,
 * which in turn overrides the built-in Russian: a missing or broken profile.json isn't a
 * reason to leave the person without a reply.
 */
export function languageOf(config: IcarusConfig, user: UserConfig): Language {
  const stored = readProfile(config, user);
  if (stored !== undefined) return stored.language;
  return config.userLanguage ?? DEFAULT_LANGUAGE;
}

/** Profile path: next to memory, so "mine" lies in one place. */
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
    // The file is edited by hand too, so a broken profile isn't a crash: the language
    // stays as before (the default), and the log shows exactly what failed to parse.
    log.warn('профиль человека не разобрался — язык останется из конфига', {
      user: user.id,
      file,
      error: String(error),
    });
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const raw = parsed as Record<string, unknown>;
  const language = raw.language;
  if (!isLanguage(language)) return undefined;
  // An old profile has no line of its own — the interface stays Russian. An unknown
  // locale is also no reason not to render the panel: the reply language is preserved.
  const uiLanguage = isUiLanguage(raw.uiLanguage) ? raw.uiLanguage : DEFAULT_UI_LANGUAGE;
  return { language, uiLanguage };
}

/** Write the settings. The directory is created: the panel may outpace the service's first start. */
export function writeProfile(config: IcarusConfig, user: UserConfig, profile: Profile): void {
  const file = profilePath(config, user);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    stringifyYaml({ language: profile.language, uiLanguage: profile.uiLanguage }),
    { mode: 0o600 },
  );
}
