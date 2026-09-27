# Microsoft Edge Add-ons listing

Version 1.0.0 is published at [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/your-name-for-threads/ojnkchiogffjbniepbngfokiapfahmpb). Later updates use the release workflow described in [Release pipeline](release-pipeline.md).

The maintainer confirmed the 1.1.0 listing, privacy fields, translations and demo assets against the existing store dashboard on 2026-09-27. Account-specific publisher and registration values remain in that dashboard. This file is the reusable submission reference; store review and publication remain separate steps. The ID in the public listing URL is not the Partner Center Product ID required by the update API.

The listing text, the purpose, the permission justifications, the reviewer's instructions and the data table are the same as the Chrome listing's, word for word, and a test holds them equal (`tests/repo/store-listings.test.ts`), so the two stores and the privacy policy cannot disagree. The same test holds the rest to what a machine can hold: the summary is the manifest's own description, the addresses are the ones the extension links to, the descriptions repeat the README and About & Privacy sentences word for word, every row of the data table is a row of the Data Handling Matrix, and the two permissions here are the two in the manifest. It cannot say whether the copy is good, or whether Partner Center's form is what is described here.

## Store fields

| Field | Value |
| --- | --- |
| Extension name | Your Name for Threads. From the manifest (`extension_name`), which Partner Center shows read-only. |
| Short description | The manifest's description in each language (`extension_description`), under "Listing copy" below. Partner Center shows it read-only and changes only when the package is uploaded again. |
| Description | Required for every language: at least 250 and at most 10,000 characters. See "Listing copy". |
| Category | The applicable social or communication category was reviewed in the existing Partner Center listing for 1.1.0. |
| Website | https://marslento.github.io/your-name-for-threads/ . Microsoft asks for the project's own page, not the store listing. |
| Support contact detail | https://marslento.github.io/your-name-for-threads/support . A URL, so no email address is published. |
| Privacy policy URL | https://marslento.github.io/your-name-for-threads/privacy |
| Mature content | No. |
| Visibility and markets | Public, all markets. The owner may choose otherwise. |
| Extension logo | Required for every language. Square, 300 × 300 recommended, 128 × 128 at least. Make it from the 512 × 512 master, `icons/icon.png`, and use "Duplicate this logo for all languages". |
| Small promotional tile | Optional, 440 × 280. See "Graphics". |
| Large promotional tile | Optional, 1400 × 560. Not planned for 1.0. |
| Screenshots | Optional, at most 6, at 640 × 480 or 1280 × 800. See "Screenshots". |
| YouTube video URL | None. |
| Search terms | Optional, for each language, not shown to users. At most 7 terms of at most 30 characters each, and at most 21 words in all. Under "Listing copy". |
| Publisher name | Configured and reviewed in the existing store dashboard for 1.1.0. Account-specific values are maintained there. |
| Trader status | The applicable registration fields were reviewed in the existing store dashboard for 1.1.0. Account-specific values are maintained there. |
| Notes for certification | The text under "Instructions for the reviewer". |

The homepage, support and privacy addresses were checked without authentication on 2026-09-27. Recheck the deployed pages when their content changes.

## Listing copy

The short description is quoted from `_locales/<language>/messages.json`. Change it there, in all three languages, and never here alone. The full descriptions are plain text. They repeat, word for word, sentences already published in the README and in About & Privacy, so the store says nothing the extension does not. They make no claim about what Threads can see or detect, none about encryption other than that a backup is not encrypted, and none that nothing is collected: the stores ask for user data to be disclosed even when it stays on the device (see "Data usage").

### English

#### Summary

```text
Locally saved private nicknames for Threads.
```

#### Full description

```text
Give people on Threads a nickname that only you can see.

Your Name for Threads is a private address book for Threads. Nicknames show on profile pages, in the feed, in replies and in quoted posts. Notes stay in the Dashboard, where you can search, edit and back up everything.

What you can do
• Add a private nickname to any Threads profile. Only you see it.
• Keep private notes about a person in the Dashboard. Notes are never shown on Threads pages.
• Search and edit your directory in one place.
• Use several Threads accounts in the same browser. Each account keeps its own directory.
• Switch nicknames off on profile pages, in the feed, in replies or in quoted posts, or turn the whole extension off, in Settings.
• Export a JSON backup and import it again. Before anything is written you see a preview of the changes.
• If your saved data is ever damaged, the extension pauses that account's private features and lets you save a recovery file first. A single account's recovery file can then be restored, after checks and your confirmation, into that account's empty directory or back over the damaged one. Your other accounts are not affected.

Privacy
Nicknames and notes are stored in this browser and processed locally by the extension. They are not sent to the developer automatically.
This project runs no backend service that receives this data, and offers no cloud sync. There is no analytics, usage tracking, automatic crash reporting or advertising tracking.
The extension asks for two permissions: storage, and access to https://www.threads.com/*. Nothing else.
To place a nickname, the extension reads the usernames and numeric IDs that the Threads page you have open shows or loads. The privacy policy explains exactly what it reads and keeps.
A JSON backup is created only when you export one, for you to save. It contains private nicknames, notes and internal identifiers, so keep it safe and do not post it publicly. It is plain JSON and is not encrypted.
Data leaves your browser only when you do something with it: export a backup, copy diagnostics, or paste either one somewhere.

Good to know
• Latest stable Chrome and Edge. Other Chromium-based browsers are not officially supported.
• Nicknames are kept in this browser only and are not synced between devices. To move your data, export a backup.

It is an unofficial extension. This is an independent open-source project. The source code is on GitHub.

Support: https://marslento.github.io/your-name-for-threads/support
Privacy policy: https://marslento.github.io/your-name-for-threads/privacy
```

#### Search terms

```text
Threads nickname
private nickname
Threads notes
Threads address book
nickname manager
private notes
```

### 繁體中文 (zh-TW)

#### Summary

```text
本機保存的 Threads 私人暱稱。
```

#### Full description

```text
替 Threads 上的人建立只有你看得到的私人暱稱。

Your Name for Threads 是你的私人 Threads 通訊錄。暱稱會顯示在個人頁、動態貼文、回覆串與引用內容中；備註只留在通訊錄裡，你可以在那裡搜尋、編輯並備份所有資料。

你可以做什麼
• 在任何 Threads 個人頁為對方加上私人暱稱，只有你看得到。
• 在通訊錄中為對方寫下私人備註。備註不會顯示在 Threads 頁面上。
• 在同一處搜尋與編輯你的通訊錄。
• 同一個瀏覽器登入多個 Threads 帳號時，每個帳號各有自己的通訊錄。
• 在「設定」中分別開關個人頁、動態貼文、回覆串與引用內容中的暱稱，或關閉整個擴充功能。
• 匯出 JSON 備份，需要時再匯入。寫入任何資料之前，你會先看到變更預覽。
• 若儲存的資料受損，擴充功能會暫停該帳號的私人功能，並讓你先儲存一份復原檔。單一帳號的復原檔通過檢查並經你確認後，可復原到該帳號的空通訊錄，或修復原本受損的通訊錄。其他帳號不受影響。

隱私
暱稱與備註儲存在目前的瀏覽器中，由擴充功能在本機處理，不會自動傳送給開發者。
本專案不營運接收這些資料的後端服務，也不提供雲端同步。不做分析、使用行為追蹤、自動當機回報或廣告追蹤。
擴充功能只要求兩項權限：storage，以及存取 https://www.threads.com/*。沒有其他權限。
為了放置暱稱，擴充功能會讀取你開啟的 Threads 頁面所顯示或載入的使用者名稱與數字 ID。隱私權政策會說明它讀取與保留的確切內容。
只有在你主動匯出時，才會產生 JSON 備份供你儲存。備份檔包含私人暱稱、備註及內部識別資訊，請妥善保管，不要公開張貼。備份檔是純 JSON，沒有加密。
資料只有在你自己動手時才會離開瀏覽器：匯出備份、複製診斷資訊，或把其中一項貼到別處。

須知
• 支援最新穩定版 Chrome 與 Edge。其他 Chromium 系瀏覽器不在正式支援範圍內。
• 暱稱只保存在這個瀏覽器中，不會在裝置之間同步。要搬移資料，請匯出備份。

這是非官方的擴充功能。這是獨立的開源專案。原始碼公開在 GitHub。

支援：https://marslento.github.io/your-name-for-threads/support
隱私權政策：https://marslento.github.io/your-name-for-threads/privacy
```

#### Search terms

```text
Threads 暱稱
私人暱稱
Threads 備註
Threads 通訊錄
暱稱管理
私人備註
```

### 简体中文 (zh-CN)

#### Summary

```text
本机保存的 Threads 私人昵称。
```

#### Full description

```text
为 Threads 上的人建立只有你看得到的私人昵称。

Your Name for Threads 是你的私人 Threads 通讯录。昵称会显示在个人页、动态帖子、回复串与引用内容中；备注只留在通讯录里，你可以在那里搜索、编辑并备份所有数据。

你可以做什么
• 在任何 Threads 个人页为对方添加私人昵称，只有你看得到。
• 在通讯录中为对方写下私人备注。备注不会显示在 Threads 页面上。
• 在同一处搜索与编辑你的通讯录。
• 同一个浏览器登录多个 Threads 账号时，每个账号各有自己的通讯录。
• 在“设置”中分别开关个人页、动态帖子、回复串与引用内容中的昵称，或关闭整个扩展程序。
• 导出 JSON 备份，需要时再导入。写入任何数据之前，你会先看到变更预览。
• 若保存的数据受损，扩展程序会暂停该账号的私人功能，并让你先保存一份恢复文件。单个账号的恢复文件通过检查并经你确认后，可恢复到该账号的空通讯录，或修复原本受损的通讯录。其他账号不受影响。

隐私
昵称与备注保存在当前的浏览器中，由扩展程序在本机处理，不会自动发送给开发者。
本项目不运营接收这些数据的后端服务，也不提供云端同步。不做分析、使用行为追踪、自动崩溃报告或广告追踪。
扩展程序只要求两项权限：storage，以及访问 https://www.threads.com/*。没有其他权限。
为了放置昵称，扩展程序会读取你打开的 Threads 页面所显示或加载的用户名与数字 ID。隐私政策会说明它读取与保留的确切内容。
只有在你主动导出时，才会生成 JSON 备份供你保存。备份文件包含私人昵称、备注及内部标识信息，请妥善保管，不要公开发布。备份文件是纯 JSON，没有加密。
数据只有在你自己动手时才会离开浏览器：导出备份、复制诊断信息，或把其中一项粘贴到别处。

须知
• 支持最新稳定版 Chrome 与 Edge。其他 Chromium 系浏览器不在正式支持范围内。
• 昵称只保存在这个浏览器中，不会在设备之间同步。要迁移数据，请导出备份。

这是非官方的扩展程序。这是独立的开源项目。源代码公开在 GitHub。

支持：https://marslento.github.io/your-name-for-threads/support
隐私政策：https://marslento.github.io/your-name-for-threads/privacy
```

#### Search terms

```text
Threads 昵称
私人昵称
Threads 备注
Threads 通讯录
昵称管理
私人备注
```

## Single purpose

```text
Lets you give people on Threads private nicknames, and keep private notes about them, that only you can see. Everything is saved in your own browser.
```

## Permission justifications

The two permissions in the manifest, and nothing else. `docs/release/permission-audit.md` lists what each one is needed for, and what was deliberately not requested.

### storage

```text
Saves the person's nicknames, notes and settings in the browser's extension storage on their own device. Without it nothing could be kept.
```

### https://www.threads.com/*

```text
Runs the extension on Threads pages only. It shows a nickname in place of a display name on profiles, in the feed, in replies and in quoted posts, and reads the usernames, and the numeric IDs that Threads itself sends to the page, that it needs to know which person a nickname belongs to. It also lets the popup tell whether the current tab is Threads. The extension asks for no other site.
```

## Remote code

```text
No. All of the extension's code is in the package it is submitted with. It loads no script or stylesheet from anywhere else and makes no network request of its own.
```

That is checked, not only stated: a test scans `src/` for network APIs, `eval`, `new Function` and `importScripts` (only the page observer may mention `fetch` and `XMLHttpRequest`, to read what Threads itself loads), and `pnpm release:audit` refuses a package that contains a remote script, stylesheet, `@import`, `importScripts` or dynamic `import()`.

## Data usage

Partner Center's Privacy page asks which user data the extension collects "now or in the future", and asks the developer to certify the disclosures, which have to agree with the privacy policy. Microsoft's page does not say whether data that only stays on the device counts. Chrome's rules say it does, so the answers here are the same as the Chrome listing's, and the two stores and the policy agree. This extension handles the data below and sends none of it anywhere: nothing goes to the developer or to any third party, and the developer runs no server. The rows are the rows of the Data Handling Matrix (`docs/privacy/data-handling-matrix.md`), which has the detail, and the privacy policy is written from it.

The middle column maps the data matrix to store categories. The maintainer reviewed the applicable dashboard fields for 1.1.0; future submissions must compare these mappings with the then-current form and actual data handling.

| Matrix row | Declare as | Leaves the device? |
| --- | --- | --- |
| Threads username | Website content; personally identifiable information | No |
| Numeric Threads ID | Personally identifiable information | No |
| Nickname | User-generated content | No |
| Note | User-generated content | No |
| Tombstones | Personally identifiable information (a username and ID, never the nickname or note) | No |
| Identity cache | Web browsing activity (which accounts a Threads page has shown); personally identifiable information | No |
| Current-account state | Personally identifiable information (the signed-in account's own username and ID); memory only | No |
| Integration status (in memory only) | None: a fixed list of values, no user data | No |
| Settings | None: on and off values | No |
| First-run tour flag | None: one on or off value | No |
| Last-seen notice ID | None: one short ID, and none is set in 1.0 | No |
| Diagnostic event codes | None: closed codes only, no free text | No |
| Copied diagnostics | None: fixed labels, versions and numbers, the browser and operating system family, and the event codes; no username, note, address or error message | No, unless the person pastes it |
| Backup file | User-generated content; personally identifiable information. It exists only when the person exports one | No, unless the person shares the file |
| Recovery dump | The same as a backup, unchecked. It exists only when the person exports one | No, unless the person shares the file |
| Threads page traffic (in memory only) | Website content, read as it passes; only username and ID pairs are kept | No |

The certifications Partner Center asks for are, as I understand them, the same statements Chrome asks for: user data is not sold or transferred to third parties outside the approved uses, is not used for anything unrelated to the single purpose, and is not used for creditworthiness or lending. All are true here. Read each one in Partner Center before ticking it.

## Instructions for the reviewer

```text
The extension has no account, login or server of its own, so there are no credentials to give. It works with any Threads account, and only on https://www.threads.com/.

1. Install it and open its popup. "Open Directory" opens the Dashboard, which is empty.
2. Sign in to Threads with any account and open any profile.
3. Choose "Add nickname", type a nickname of 1 to 25 characters and choose "Save". The nickname appears on the profile, and on that person's posts and replies.
4. In the Dashboard, "Directory" lists that person. Open it to add a private note. Notes are never shown on Threads.
5. "Settings" switches the extension, and each place nicknames show, on and off.
6. "Backup & Import" exports a JSON backup and previews an import before anything is written.
7. "About & Privacy" has the privacy statement and "Copy diagnostics".
8. With DevTools open on the Network tab of a Threads page, the extension makes no requests of its own.

The extension does nothing on any other site.
```

## Screenshots

Edge takes at most 6, at 640 × 480 or 1280 × 800, of the real interface. Take them from the release build, not from `pnpm dev`, at exactly 1280 × 800 as PNG, once for each language the listing has (the extension follows the browser's language).

**Demo data only.** Nothing that belongs to a real person may appear: no real username, nickname, note, avatar, post or backup, and no other tab, bookmark, profile picture or account name in the browser frame. Use a fresh browser profile. Every Threads username, avatar, post and reply visible in a screenshot has to belong to a demo account the owner controls. Enter exactly these contacts, so every screenshot in every language shows the same story:

| Username | Nickname | Note |
| --- | --- | --- |
| demo_alice_reads | Book club Alice | Met at the demo meetup. Recommends science fiction. |
| demo_ben_runs | Ben (running) | Training for a demo race in spring. |
| demo_chen_cooks | Chen, sourdough | Shared a demo starter recipe. |
| demo_dana_draws | Dana (sketches) | Demo illustrations. Ask about the workshop. |
| demo_eli_codes | Eli from the meetup | Demo talk on accessibility. |
| demo_fay_hikes | Fay, trail notes | Demo trail tips for the summer. |

Before using a username, check that it is not a real person's account, or that it is a demo account the owner controls.

1. **A nickname on a profile.** A demo account's Threads profile with its private nickname shown. Nothing else from Threads in the frame.
2. **The Directory.** The six demo contacts, one of them searched for.
3. **Editing a contact.** The edit drawer with a private note.
4. **Backup & Import.** An import preview of a demo backup file.
5. **About & Privacy.** The privacy statement at the top of the page.
6. **The popup and Settings.** The popup on a Threads tab, or the places nicknames are shown.

Do not use the Threads logo, Meta's name or anything that looks like Threads or Meta branding in a screenshot or a tile, beyond the Threads page itself in the first one.

## Graphics

| Asset | Source | State |
| --- | --- | --- |
| Extension logo, 300 × 300 | Exported from `icons/icon.png` (512 × 512) | Reviewed in the existing store listing for 1.1.0. |
| Small promotional tile, 440 × 280 | The icon and the name, on a plain background. No Threads or Meta logo, no claim. | Reviewed in the existing store listing for 1.1.0. |
| Large promotional tile | None | Not planned. |

## Before submitting

- [x] The publisher name is decided in the Partner Center registration.
- [x] The three addresses load without an authenticated session.
- [x] The owner has read the zh-TW and zh-CN copy.
- [x] Every answer above has been compared with Partner Center's form, and the field limits with Partner Center.
- [x] The screenshots, the logo and the small promotional tile exist, and were checked against "Demo data only".
- [x] Each language's short description shown in Partner Center is the manifest's description.
- [x] `PRIVACY.md` and this copy still agree, and the site's privacy page has been rebuilt (`pnpm build:site`).
- [x] `pnpm release:audit --release` passes on the package that is uploaded.

## Sources

Read on 2026-09-19. Check it again when the form is filled in, because store forms change.

- https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension
