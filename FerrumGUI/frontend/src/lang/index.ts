import { en_US } from './en_US';
import { ja_JP } from './ja_JP';

export type Language = 'en_US' | 'ja_JP';

const translations = {
  en_US,
  ja_JP,
};

let currentLanguage: Language = 'ja_JP'; 

export function setLanguage(lang: Language) {
  currentLanguage = lang;
  if (typeof window !== 'undefined') {
    localStorage.setItem('language', lang);
  }
}

export function getLanguage(): Language {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('language') as Language;
    if (saved && translations[saved]) {
      currentLanguage = saved;
    }
  }
  return currentLanguage;
}

export function t(key: keyof typeof en_US): string {
  const lang = getLanguage();
  return translations[lang][key];
}

export { en_US, ja_JP };
