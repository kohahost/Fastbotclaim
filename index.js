const StellarSdk = require('stellar-sdk');
const { Keypair, TransactionBuilder, Operation, Asset } = StellarSdk;
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
const fs = require('fs');
require("dotenv").config();

/**
 * Mengirim pesan notifikasi ke channel/grup Telegram.
 * @param {string} message Pesan yang akan dikirim.
 */
async function sendTelegramMessage(message) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return;

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    try {
        await axios.post(url, {
            chat_id: chatId,
            text: message,
            parse_mode: 'Markdown'
        });
    } catch (err) {
        console.error("⚠️ Gagal kirim ke Telegram:", err.message);
    }
}

/**
 * Mendapatkan public dan secret key dari mnemonic phrase.
 * @param {string} mnemonic Mnemonic phrase dari akun Pi.
 * @returns {Promise<{publicKey: string, secretKey: string}>}
 */
async function getPiWalletAddressFromSeed(mnemonic) {
    if (!bip39.validateMnemonic(mnemonic)) throw new Error(`Mnemonic tidak valid: ${mnemonic.substring(0, 10)}...`);
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const derivationPath = "m/44'/314159'/0'";
    const { key } = ed25519.derivePath(derivationPath, seed.toString('hex'));
    const keypair = Keypair.fromRawEd25519Seed(key);
    return { publicKey: keypair.publicKey(), secretKey: keypair.secret() };
}

/**
 * Memproses satu akun: memeriksa claimable balance dan mengirimkannya jika ada.
 * @param {object} account Objek akun yang berisi name, mainMnemonic, sponsorMnemonic, receiverAddress.
 * @param {StellarSdk.Horizon.Server} server Instance server Stellar untuk digunakan kembali.
 */
async function processAccount(account, server) {
    const accountIdentifier = account.name || account.mainMnemonic.substring(0, 15) + '...';
    console.log(`\n============== Memproses: ${accountIdentifier} ==============`);

    const { mainMnemonic, sponsorMnemonic, receiverAddress } = account;

    if (!mainMnemonic || !sponsorMnemonic || !receiverAddress) {
        console.error(`❌ Error: Konfigurasi tidak lengkap untuk akun ${accountIdentifier}`);
        return;
    }

    const networkPassphrase = 'Pi Network';

    try {
        const mainWallet = await getPiWalletAddressFromSeed(mainMnemonic);
        const sponsorWallet = await getPiWalletAddressFromSeed(sponsorMnemonic);
        const mainKeypair = Keypair.fromSecret(mainWallet.secretKey);
        const sponsorKeypair = Keypair.fromSecret(sponsorWallet.secretKey);

        const claimables = await server
            .claimableBalances()
            .claimant(mainKeypair.publicKey())
            .limit(10)
            .call();

        if (claimables.records.length === 0) {
            console.log(`📭 Tidak ada claimable balance untuk ${accountIdentifier}.`);
            return;
        }

        for (const cb of claimables.records) {
            console.log(`💰 Ditemukan Claimable Balance untuk ${accountIdentifier}: ${cb.amount} Pi`);

            const mainAccount = await server.loadAccount(mainKeypair.publicKey());

            const innerTransaction = new TransactionBuilder(mainAccount, { fee: '0', networkPassphrase })
                .addOperation(Operation.claimClaimableBalance({ balanceId: cb.id }))
                .addOperation(Operation.payment({
                    destination: receiverAddress,
                    asset: Asset.native(),
                    amount: cb.amount,
                }))
                .setTimeout(60)
                .build();

            innerTransaction.sign(mainKeypair);

            const baseFee = await server.fetchBaseFee();
            const feeBumpTransaction = TransactionBuilder.buildFeeBumpTransaction(
                sponsorKeypair.publicKey(),
                (parseInt(baseFee) * 120).toString(),
                innerTransaction,
                networkPassphrase
            );

            feeBumpTransaction.sign(sponsorKeypair);

            console.log(`🚀 Mengirim transaksi untuk ${accountIdentifier}...`);
            const result = await server.submitTransaction(feeBumpTransaction);
            console.log(`✅ Sukses! Hash: ${result.hash}`);
            await sendTelegramMessage(
                `✅ **Klaim & Kirim Sukses (${account.name})**\n*Jumlah:* ${cb.amount} Pi\n*Tx Hash:* [${result.hash.substring(0, 15)}...](https://blockexplorer.minepi.com/mainnet/transactions/${result.hash})`
            );
        }
    } catch (e) {
        if (e.response && e.response.status === 429) {
            console.error(`🔴 RATE LIMITED saat memproses ${accountIdentifier}. Server memblokir sementara karena terlalu banyak permintaan.`);
        } else {
            const errorMessage = e.response?.data?.extras?.result_codes || e.message;
            console.error(`❌ Error saat memproses ${accountIdentifier}:`, errorMessage);
        }
    }
}

/**
 * Fungsi utama yang mengatur loop tak terbatas untuk semua bot.
 */
async function runAllBotsContinuously() {
    console.log("Membaca konfigurasi akun dari 'accounts.json'...");
    let accounts;
    try {
        const accountsData = fs.readFileSync('accounts.json', 'utf-8');
        accounts = JSON.parse(accountsData);

        if (!accounts || accounts.length === 0) {
            console.error("❌ File 'accounts.json' kosong atau tidak ditemukan. Bot berhenti.");
            return;
        }
        console.log(`🤖 Konfigurasi untuk ${accounts.length} akun berhasil dimuat. Memulai loop super cepat.`);
    } catch (error) {
        console.error("🔥 Gagal membaca atau mem-parsing 'accounts.json':", error.message);
        return;
    }

    const server = new StellarSdk.Horizon.Server('https://apimainnet.vercel.app');

    // Loop tak terbatas
    while (true) {
        console.log("\n---🔄 Memulai siklus pengecekan baru 🔄---");
        for (const account of accounts) {
            await processAccount(account, server);
        }
        console.log("---✅ Siklus selesai, langsung memulai lagi ---");
    }
}

// --- EKSEKUSI UTAMA ---
console.log("🚀 Memulai bot klaim Pi...");
runAllBotsContinuously().catch(err => {
    console.error("FATAL ERROR PADA LOOP UTAMA:", err);
});
