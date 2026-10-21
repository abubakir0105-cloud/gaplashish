# Gaplashish v2 — chat + SSH terminal

json-server yo'q. Server (Node.js) ikkita narsani qiladi:
- **Chat** — WebSocket orqali, xabarlar `data/messages.json` da saqlanadi.
- **Terminal** — brauzer SSH serverga (noutbukning o'zi) ulanadi; haqiqiy terminal (xterm.js).

## 1. Noutbukda bir martalik sozlash (Windows)

**a) OpenSSH serverni yoqish** (administrator PowerShell):
```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
```

**b) Faqat shu sayt uchun alohida, huquqi cheklangan foydalanuvchi yarating** (administrator cmd yoki PowerShell):
```powershell
net user gost KUCHLI_PAROL_YOZING /add
```
Bu foydalanuvchini Administrators guruhiga QO'SHMANG. Saytdagi terminalga o'z asosiy (admin) akkauntingiz bilan kirmang.

**c) Tekshirish:** `ssh gost@localhost` ishlashi kerak.

## 2. Saytni ishga tushirish
```powershell
npm.cmd install
npm.cmd start
```
Terminalda **KIRISH KODI** chiqadi. Uni faqat ishongan odamlarga bering.
Brauzerda `http://localhost:3000` oching.

## 3. Internetga chiqarish (do'stlar uchun)
Yangi terminalda:
```powershell
cloudflared tunnel --url http://localhost:3000
```
Chiqqan `https://....trycloudflare.com` manzilini yuboring.

## Terminalga kirish
Saytda "Terminal (SSH)" tabiga o'ting -> Kirish kodi + SSH login (`gost`) + parol -> Ulanish.

## Himoya
- SSH'ga urinishdan oldin **kirish kodi** talab qilinadi (kodsiz parol sinab bo'lmaydi).
- 10 daqiqada 5 ta xato urinishdan keyin IP 10 daqiqaga bloklanadi.
- Bir vaqtda ko'pi bilan 3 seans, 30 daqiqa harakatsizlikdan keyin seans yopiladi.
- Server faqat `sshHost` (standart: shu noutbuk) ga ulanadi, boshqa manzilga ulana olmaydi.
- Boshqa saytlardan kelgan WebSocket so'rovlari rad etiladi.

Sozlamalar `config.json` da: `port`, `host` (Wi-Fi'dagi boshqa qurilmalar uchun `0.0.0.0`), `sshHost`, `sshPort`, `accessCode` (bo'sh bo'lsa har safar tasodifiy), `maxSessions`, `idleMinutes`.
