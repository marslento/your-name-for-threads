export interface NicknameDisplaySettings {
  profile: boolean;
  feed: boolean;
  replies: boolean;
  quotes: boolean;
}

export interface ExtensionSettings {
  enabled: boolean;
  nicknameDisplay: NicknameDisplaySettings;
}

export const DEFAULT_NICKNAME_DISPLAY_SETTINGS: NicknameDisplaySettings = Object.freeze({
  profile: true,
  feed: true,
  replies: true,
  quotes: true,
});

export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = Object.freeze({
  enabled: true,
  nicknameDisplay: DEFAULT_NICKNAME_DISPLAY_SETTINGS,
});
