# SPEC — Post-Quantum AI Agents entry: Arbitrage agent with on-chain limits

**Kategori:** Post-Quantum AI Agents (Build Before Q-Day, QoreChain Developer Fest)
**Tujuan:** agen otonom yang mengeksekusi arbitrase antar dua pool AMM — dengan
SEMUA batas ditegakkan on-chain oleh vault kontrak: cap per-trade, cap harian,
allowlist target, durasi otorisasi, auto-halt, dan log audit on-chain.
Arbitrase disebut eksplisit di contoh event tapi NOL builder mengerjakannya
(9 agen yang ada: 2 DCA, 3 treasury/pembayaran, 1 wallet, 1 visualisasi,
1 governance engine, 1 rencana inferensi). Auto-halt + log audit tidak
dimiliki agen manapun di fest.
**Direktori kerja:** `~/workspace/qorechain-bounty/build-before-qday/ai-agent/`
**Deadline event:** 2 Des 2026 23:59 UTC. Kerjakan dengan steady; kualitas dulu.

## Lingkungan & toolchain

- **Kontrak + tes: Foundry.** Binary di `~/workspace/tools/foundry/bin`
  (`forge`, `cast`; Foundry 1.9.0, solc 0.8.28). Proyek Foundry di `contracts/`.
- **Agen off-chain: skrip Node.js/TypeScript** di `agent/` (boleh memakai
  `@qorechain/sdk` / `viem` / `ethers` — pilih satu, dokumentasikan).
- **Frontend dashboard: scaffold FRESH** `npx -y create-qorechain-dapp@0.14.0
  qore-arb-agent --template viem-wagmi --network testnet --yes` di `app/`.
  Auto-install scaffolder akan GAGAL (ia memanggil `pnpm`, tidak ada di VM) —
  itu normal; lanjutkan `npm install` manual (~11 menit, timeout minimal
  15 menit), lalu `npm run build` harus exit 0.
- **JANGAN PERNAH membaca** `~/workspace/qorechain-bounty/build-before-qday/toolchain-test/`,
  `~/workspace/qorechain-bounty/build-before-qday/quantum-pass/`,
  `~/workspace/qorechain-bounty/build-before-qday/dapp-vault/`, atau kode
  proyek/entri lain mana pun — termasuk repo audit lokal
  `~/workspace/qorechain-bounty/qorechain-core/` dan catatan audit di
  `~/workspace/qorechain-bounty/`. Tulis semua baris dari spesifikasi ini.
  Kamu BOLEH membaca: dokumentasi resmi docs.qorechain.io, repo PUBLIK
  github.com/qorechain/qorechain-core (HANYA untuk antarmuka modul AMM x/amm
  dan precompile PQC — lihat §AMM), dan definisi tipe di `node_modules`
  proyekmu SENDIRI.
- **JANGAN PERNAH menuliskan** kunci, seed phrase, mnemonic, atau kredensial
  apa pun ke file mana pun. Kunci privat agen HANYA dibaca dari environment
  saat runtime (`.env` lokal, ter-gitignore, TIDAK PERNAH di-commit);
  dokumentasikan ini dengan jelas.
- **TANPA MAINNET.** Testnet `qorechain-diana` (EVM 9800) + devnet lokal saja.

## Jaringan (data persis)

- **Testnet publik `qorechain-diana`** (EVM chain ID 9800):
  EVM JSON-RPC `https://evm-testnet.qore.host`,
  Cosmos REST `https://api-testnet.qore.host`,
  Cosmos RPC `https://rpc-testnet.qore.host`.
  1 QOR = 10^6 uqor = 10^18 wei; 1 uqor = 10^12 wei.
- **Devnet lokal** (untuk tes deploy + E2E):
  - chain-id `qorechain-devnet`; Cosmos RPC `http://localhost:26657`;
    EVM JSON-RPC `http://localhost:8545`.
  - binary `~/workspace/qorechain-bounty/bin/qorechaind`, wajib
    `LD_LIBRARY_PATH=$HOME/workspace/qorechain-bounty/bin/lib`
  - keyring home `~/workspace/qorechain-bounty/devnet/node1`,
    `--keyring-backend test`
  - **REST :1317 di devnet TIDAK aktif** — pakai RPC/CLI untuk devnet.
  - Fee minimum efektif native: **60.000 uqor** per tx (bukan 50.000).
  - `qorechaind tx` butuh `--yes` + stdin `/dev/null`.
  - Akun dengan kunci PQC terdaftar WAJIB tanda tangan hybrid untuk tx native:
    buat tx `--generate-only`, lalu
    `tx pqc cosign <file.json> --from <nama> --pqc-key <nama>
    --chain-id qorechain-devnet --fees 60000uqor --gas 400000`
    (flag `--chain-id` WAJIB eksplisit — tanpa itu gagal CheckTx code 21
    dengan error PQC yang menyesatkan).
  - **Code-0 saat broadcast BUKAN konfirmasi** — selalu verifikasi dengan
    `query tx <hash>` (DeliverTx code) / `eth_getTransactionReceipt`.
  - **EVM send hanya diterima bila akun punya ML-DSA-87 key terdaftar + EVM
    authorisation window terbuka** (window devnet: 600 blok, 5 tx; tunggu
    ~10 detik setelah open karena nonce akun maju). Daftarkan kunci
    (`tx pqc register-key-v2`) + buka window sebelum interaksi EVM.
  - **Kunci Cosmos biasa TIDAK BISA mengirim tx EVM.** Akun EVM harus
    "unified" (kunci `eth_secp256k1`, dibuat dengan
    `keys add --key-type eth_secp256k1 --coin-type 60`).
  - Precompile PQC sudah aktif di devnet (diaktifkan lewat gov proposal 25).
- **Akun tes devnet (unified, sudah didanai):**
  - `ag-owner` = `qor1jgdvuseqk620ze5j832fxwzkpujv4nekrm9r48` — 10 QOR.
    Pemilik vault + pengatur policy.
  - `ag-agent` = `qor1saz0z8ukhd38qzaxhx308kkjgflrz6ynhmanvj` — 10 QOR.
    Akun yang menjalankan agen (mengeksekusi trade lewat vault).
  - `evmtest` = `qor1rfuuvt9j8e5p8muzj20ztq2gy25zzemk3us2q2` /
    `0x1A79C62CB23E6813EF82929E25814822A8216776` — 11,84 QOR, SUDAH punya
    kunci PQC + pengalaman window (cadangan).
  - Alamat EVM masing-masing = 20 byte yang sama dengan alamat `qor1`
    (decode bech32; jangan ditebak — hitung dari alamat di atas).
  - Akun `dv-*` (dv-owner/dv-guardian/dv-attacker) adalah kunci Cosmos biasa
    — TIDAK BISA untuk EVM; jangan pakai untuk entry ini.

## LANGKAH PERTAMA WAJIB — verifikasi antarmuka AMM (sebelum menulis kontrak agen)

Modul AMM native QoreChain adalah `x/amm` (modul Cosmos). Sebelum membangun
logika arbitrase, verifikasi dari docs.qorechain.io + repo publik
qorechain-core + state live (devnet/testnet):
1. Bagaimana membaca harga/isi pool (query apa? REST/gRPC/CLI? adakah pool
   yang live di devnet/testnet? pasangan token apa?).
2. Bagaimana mengeksekusi swap (pesan Cosmos apa? adakah jalur EVM?).
3. Apakah agen (akun unified) bisa melakukan keduanya dari skrip Node.
**Tulis hasilnya di `AMM-RESEARCH.md`** (apa yang ditemukan, dari sumber apa,
perintah/query persis + output). Keputusan:
- **Bila AMM bisa dipakai:** lanjutkan arbitrase sesuai §Perilaku di bawah.
- **Bila AMM TIDAK bisa dipakai** (tidak ada pool live / tidak ada jalur yang
  bisa dieksekusi / dokumentasi tidak cukup — setelah dicoba sungguh-sungguh):
  **PIVOT ke DCA agent** dengan vault + batas + auto-halt + audit log yang
  SAMA (lihat §Fallback), dan dokumentasikan alasan pivot di README +
  `AMM-RESEARCH.md`. Jangan memalsukan trade — semua trade demo harus tx
  on-chain nyata (devnet) dengan receipt.

## Perilaku kontrak (satu kontrak utama: `AgentVault.sol`)

### State & peran
- `owner` — ditetapkan di constructor; satu-satunya yang bisa mengubah policy,
  menambah/menghapus target allowlist, mengisi dana (siapa pun boleh deposit),
  menghentikan (halt) dan melanjutkan (resume) vault, dan mengganti agen.
- `agent` — alamat yang ditunjuk owner; SATU-SATUNYA yang bisa mengeksekusi
  trade lewat vault.
- Policy (constructor params + bisa diubah owner):
  - `maxPerTrade` — jumlah maksimum per satu trade (deploy tes: 0,5 QOR).
  - `dailyLimit` — total maksimum per 24 jam bergulir (deploy tes: 2 QOR).
  - `allowedTargets` — allowlist alamat kontrak yang boleh dipanggil agen
    (pool AMM / router). Panggilan ke alamat di luar allowlist → revert.
  - `authExpiry` — timestamp kedaluwarsa otorisasi agen (deploy tes: 7 hari
    dari deploy). Trade setelah expiry → revert.
  - `maxConsecutiveLosses` — jumlah kerugian beruntun yang memicu auto-halt
    (deploy tes: 3).
- `halted` — bila `true`, tidak ada trade yang bisa dieksekusi. Di-set
  otomatis oleh auto-halt atau manual oleh owner; hanya owner bisa resume.

### Fungsi (nama bebas selama perilaku persis; dokumentasikan ABI final)
1. `deposit()` payable — siapa pun boleh deposit QOR. Emit `Deposited`.
2. `executeTrade(address target, bytes calldata, uint256 valueIn, uint256 minOut)`
   — hanya `agent`, hanya bila tidak halted, hanya bila dalam masa otorisasi,
   hanya bila `target` ada di allowlist, hanya bila `valueIn <= maxPerTrade`,
   hanya bila total 24 jam terakhir + `valueIn <= dailyLimit`. Melakukan call
   ke target dengan value, memeriksa hasil (bila call gagal → revert;
   bila output < `minOut` → revert). Mencatat hasil trade (untung/rugi vs
   `valueIn` — rancang pengukuran P&L dan dokumentasikan), meng-update
   hitungan kerugian beruntun, dan **auto-halt** bila kerugian beruntun
   mencapai `maxConsecutiveLosses` atau bila budget harian habis.
   Emit `TradeExecuted` (dengan P&L) dan `AutoHalted` bila terpicu.
3. `halt()` / `resume()` — hanya owner. Emit `Halted` / `Resumed`.
4. `setPolicy(...)` — hanya owner (ubah cap/allowlist/expiry/maxLosses).
   Emit `PolicyUpdated`.
5. `setAgent(address)` — hanya owner. Emit `AgentChanged`.
6. `withdraw(uint256 amount, address to)` — hanya owner (menarik dana keluar
   vault). Emit `Withdrawn`.
7. View: `spentLast24h()`, `consecutiveLosses()`, `isHalted()`, `isAllowed(target)`,
   `balance()`, `owner()`, `agent()`, parameter policy.
- **Keamanan wajib:** checks-effects-interactions; reentrancy guard pada
  executeTrade/withdraw; tidak ada fungsi yang memindahkan dana selain
  executeTrade (ke allowlist) dan withdraw (owner saja); agen tidak bisa
  mengubah policy / menarik dana langsung / memanggil target di luar allowlist.

### Event (minimal)
`Deposited`, `TradeExecuted(uint256 indexed id, address indexed target, uint256 valueIn, uint256 valueOut, int256 pnl, bool profitable)`, `AutoHalted(string reason)`, `Halted`, `Resumed`, `PolicyUpdated`, `AgentChanged`, `Withdrawn`.

### Log audit
Skrip `agent/export-audit-log.mjs` (atau setara) yang membaca event
`TradeExecuted` + `AutoHalted` dari kontrak dan mengekspor log audit
JSON (+ CSV bila mudah) dengan: id trade, waktu, target, valueIn, valueOut,
P&L, status halt. Log harus bisa direproduksi dari chain (bukan dari memori
agen).

## Perilaku agen off-chain (`agent/`)
- Skrip `run-agent.mjs` (atau `.ts`): loop observasi → keputusan → eksekusi:
  1. Baca harga kedua pool (dari AMM — sesuai hasil verifikasi §AMM).
  2. Hitung spread bersih (dikurangi estimasi fee/gas). Bila spread > ambang
     (config, mis. 0,5%), siapkan trade.
  3. Periksa batas LOKAL dulu (mirror policy on-chain: per-trade, harian,
     allowlist, expiry, halted) — jangan kirim trade yang pasti ditolak
     on-chain; catat penolakan lokal di log.
  4. Eksekusi via `executeTrade` di vault (dari akun `ag-agent`).
  5. Catat hasil (hash tx, P&L) ke log run.
  6. Berhenti sendiri (exit dengan pesan jelas) bila vault halted atau
     otorisasi kedaluwarsa atau budget harian habis.
- Mode demo: skrip harus bisa jalan dalam SATU run tercatat (bukan daemon
  24/7) — mis. `--max-trades N --duration-minutes M` — dan menghasilkan
  `agent/run-log-<tanggal>.json` dengan semua observasi + keputusan + tx.
- **Authenticated messaging (syarat kategori):** semua perubahan policy
  adalah panggilan on-chain hanya-owner (`msg.sender == owner` adalah
  otentikasinya); eksekusi trade hanya dari alamat agen yang terdaftar di
  vault; skrip agen menandatangani setiap trade dengan kunci akun agen.
  Dokumentasikan desain ini di README (bagian "Authenticated messaging").

## Fallback — DCA agent (HANYA bila AMM tidak bisa dipakai)
- Vault + batas + auto-halt + audit log TETAP SAMA (kontrak tidak berubah).
- Agen membeli jumlah tetap (mis. 0,1 QOR) dari SATU pool/token target pada
  interval tetap (mis. tiap 10 menit dalam run demo), hanya bila harga dalam
  band yang diizinkan (config min/max price — bila di luar band, lewati +
  catat). Semua batas vault tetap berlaku. Demo: satu run tercatat dengan
  ≥3 pembelian nyata di devnet + audit log.

## Perilaku frontend (`app/`)
- Connect wallet (RainbowKit + QoreX, pola scaffold).
- Status vault: saldo, halted/aktif, otorisasi agen (sisa waktu), cap
  per-trade + harian (terpakai/sisa), kerugian beruntun.
- Riwayat trade dari event on-chain (tabel: waktu, target, in/out, P&L).
- Kontrol owner: halt/resume, ubah policy, ganti agen, withdraw.
- Status agen: terakhir berjalan kapan, run terakhir (tautkan ke run-log bila
  dipublikasikan di repo).
- Penjelasan jujur: semua aksi EVM butuh EVM window terbuka.

## Pengujian (WAJIB lolos semua sebelum handoff)

1. **Foundry unit tests** (`forge test`, tanpa jaringan) — cakup SEMUA ini:
   - deposit + event; executeTrade oleh agen dalam batas → berhasil.
   - executeTrade oleh non-agen → revert; oleh owner (bukan agen) → revert
     (owner tidak bisa trade langsung — hanya lewat agen).
   - target di luar allowlist → revert; valueIn > maxPerTrade → revert;
     melewati dailyLimit → revert; setelah authExpiry → revert;
     saat halted → revert.
   - output < minOut → revert; call target gagal → revert.
   - auto-halt setelah N kerugian beruntun (simulasikan trade merugi via
     mock target); resume hanya owner; setelah resume trade bisa jalan lagi.
   - setPolicy hanya owner; setAgent hanya owner; withdraw hanya owner;
     agen TIDAK BISA withdraw / setPolicy / setAgent.
   - reentrancy: target jahat tidak bisa menguras vault lewat executeTrade.
2. **Unit test logika agen** (pure function, tanpa jaringan): perhitungan
   spread bersih, cek batas lokal (per-trade/harian/allowlist/expiry),
   kondisi halt — termasuk kasus tepi (spread tepat di ambang, budget tepat
   habis).
3. **E2E devnet:** deploy vault (dari `ag-owner`), deposit, daftarkan agen
   (`ag-agent`), jalankan agen dalam SATU run tercatat melawan pool nyata
   (atau fallback DCA): minimal 1 trade sukses on-chain + 1 penolakan
   (batas) yang terdokumentasi (lokal atau on-chain revert) + export audit
   log dari event. Catat alamat kontrak + semua hash tx di handoff.
4. **Frontend:** `npm run build` exit 0 di `app/`; `npm run dev` HTTP 200.
5. **Revisi wajib:** setelah run pertama yang bekerja, lakukan minimal SATU
   revisi nyata, lalu jalankan ulang semua tes.

## File yang harus ada di repo
- `README.md` — apa itu, kenapa beda (arbitrase = contoh event yang belum
  dibangun siapa pun; auto-halt + audit log), arsitektur, cara menjalankan
  (agen + dashboard), cara menguji, cara deploy (devnet + testnet), desain
  authenticated messaging, batasan yang diketahui, kredit: template
  `create-qorechain-dapp` + SDK QoreChain + Foundry.
- `AMM-RESEARCH.md` — hasil verifikasi antarmuka AMM (lihat §LANGKAH PERTAMA).
- `AI_USAGE.md` — dokumentasikan workflow AI-native dengan jujur dan spesifik
  (syarat special award Best AI-Native Build $500).
- `LICENSE` — MIT, diketik dari ingatan, dengan baris identifier SPDX.
- `.gitignore` — `node_modules/`, `dist/`, `out/`, `cache/`, `broadcast/`,
  `.env`, dan sejenisnya.
- TIDAK ADA file berisi kunci/seed/kredensial.

## Kegagalan yang harus dihindari (inokulasi — P-36)
- Jangan memalsukan trade — semua trade demo harus tx on-chain nyata dengan
  receipt. Bila tidak ada peluang arbitrase nyata saat run demo, laporkan
  itu dengan jujur (0 trade karena spread < ambang) dan buktikan mesinnya
  bekerja lewat skenario yang dirancang (mis. buat divergensi harga sendiri
  dengan trade testnet/devnet, lalu agen mengeksekusi).
- Jangan mengarang data AMM — semua harga dari query live.
- Jangan mengklaim sesuatu yang tidak diuji.
- Jangan menyembunyikan error chain — tampilkan apa adanya.
- Jangan memakai mainnet, dana nyata, atau layanan berbayar apa pun.
- Jangan memberi agen kekuasaan mengubah policy atau menarik dana.

## Format handoff ke koordinator
- Direktori entri + daftar file utama + alamat kontrak devnet.
- Hasil verifikasi AMM (dipakai / pivot + alasan).
- Hasil tiap tes (perintah persis + output ringkas + PASS/FAIL).
- Hash tx devnet untuk deploy + run agen + hasil tiap trade + audit log.
- Batasan yang diketahui + apa yang masih butuh aksi user.
- Saran judul entri + satu kalimat deskripsi untuk halaman proyek.
