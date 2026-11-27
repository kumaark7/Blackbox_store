import type { CloudProvider } from './api';
import googleLogo from './providers/google-drive.svg?no-inline';
import megaLogo from './providers/mega.svg?no-inline';
import teraboxLogo from './providers/terabox.svg?no-inline';
import telegramLogo from './providers/telegram.svg?no-inline';

export const providerLogos: Record<CloudProvider, string> = {
  'google-drive': googleLogo,
  mega: megaLogo,
  terabox: teraboxLogo,
  telegram: telegramLogo,
};
