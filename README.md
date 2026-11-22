# Aaron's Reading Shots
Basketball-themed English reading game (web version). Game source is shared with the Claude artifact version; records are stored in Firebase Firestore (`families/{familyCode}/kids/{kid}/...`).
- `index.html` game, `fb-shim.js` Firebase backend (source in `src/shim.js`), `sw.js` offline app shell
- Season data: `seasons.json` -> `bank.json`, `bank_s2.json`, ...; kid dictionary `dict.json`
