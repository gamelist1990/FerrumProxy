import { en, type ClientTranslation } from "./en.lang";
import { ja } from "./ja.lang";

export type ClientLanguage = "en" | "ja";

const storageKey = "ferrumproxy-client-language";

const translations: Record<ClientLanguage, ClientTranslation> = {
  en,
  ja,
};

export function detectLanguage(): ClientLanguage {
  const saved = window.localStorage.getItem(storageKey);
  if (saved === "en" || saved === "ja") {
    return saved;
  }

  return navigator.language.toLowerCase().startsWith("ja") ? "ja" : "en";
}

export function saveLanguage(language: ClientLanguage) {
  window.localStorage.setItem(storageKey, language);
}

export function getTranslation(language: ClientLanguage): ClientTranslation {
  return translations[language];
}
