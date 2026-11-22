import { createContext, useContext } from 'react'
import { getMessages, type Locale, type Messages } from './locale'

export interface I18nContextValue {
  locale: Locale
  setLocale: (next: Locale) => void
  toggleLocale: () => void
  t: Messages
}

const defaultValue: I18nContextValue = {
  locale: 'en',
  setLocale: () => {},
  toggleLocale: () => {},
  t: getMessages('en'),
}

export const I18nContext = createContext<I18nContextValue>(defaultValue)

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}
