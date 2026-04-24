
require("dotenv").config();
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActivityType,
} = require("discord.js");
const { Pool } = require("pg");
const QRCode = require("qrcode");

const SWISH_LOGO_PATH = path.join(__dirname, "..", "assets", "swish.png");
const PAYPAL_LOGO_PATH = path.join(__dirname, "..", "assets", "paypal.png");
const CRYPTO_ASSETS = {
  solana: {
    label: "Solana",
    symbol: "SOL",
    logoPath: path.join(__dirname, "..", "assets", "crypto", "solana.png"),
    logoName: "solana.png",
  },
  ethereum: {
    label: "Ethereum",
    symbol: "ETH",
    logoPath: path.join(__dirname, "..", "assets", "crypto", "ethereum.png"),
    logoName: "ethereum.png",
  },
  litecoin: {
    label: "Litecoin",
    symbol: "LTC",
    logoPath: path.join(__dirname, "..", "assets", "crypto", "litecoin.png"),
    logoName: "litecoin.png",
  },
};
const SWISH_PINK = 0xeb2188;
const PAYPAL_BLUE = 0x003087;
const FEE_PERCENT = 8;

const REQUIRED_ROLE_ID = "1459902353145598105";
const ADMIN_ROLE_ID = "1459901934080229593";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS swap_numbers (
      user_id TEXT PRIMARY KEY,
      nummer TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_accounts (
      user_id TEXT NOT NULL,
      service TEXT NOT NULL,
      account TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, service)
    )
  `);
  // Migrate any existing swish numbers from the old table.
  await pool.query(`
    INSERT INTO payment_accounts (user_id, service, account, updated_at)
    SELECT user_id, 'swish', nummer, updated_at FROM swap_numbers
    ON CONFLICT (user_id, service) DO NOTHING
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      service TEXT NOT NULL,
      exchanger_id TEXT NOT NULL,
      customer_id TEXT,
      amount NUMERIC,
      unit TEXT,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS trades_exchanger_idx ON trades(exchanger_id)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS trades_customer_idx ON trades(customer_id)`
  );
}

async function logTrade({
  service,
  exchangerId,
  customerId,
  amount,
  unit,
  note,
}) {
  try {
    await pool.query(
      `INSERT INTO trades (service, exchanger_id, customer_id, amount, unit, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        service,
        exchangerId,
        customerId ?? null,
        amount ?? null,
        unit ?? null,
        note ?? null,
      ]
    );
  } catch (err) {
    console.error("Kunde inte logga affär:", err);
  }
}

async function setAccount(service, userId, account) {
  await pool.query(
    `INSERT INTO payment_accnts (user_id, service, account, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, service)
     DO UPDATEXCLUDED.account, updated_at = NOW()`,
    [userId, service, account]
  );
}

async function getAccount(service, userId) {
  const r = await pool.query(
    `SELECT account FROM payment_accounts WHERE user_id = $1 AND service = $2`,
    [userId, service]
  );
  return r.rows[0]?.account ?? null;
}

async function clearAccount(service, userId) {
  const r = await pool.query(
    `DELETE FROM payment_accounts WHERE user_id = $1 AND service = $2`,
    [userId, service]
  );
  return r.rowCount > 0;
}

async function listAccounts(service) {
  const r = await pool.query(
    `SELECT user_id, account, updated_at FROM payment_accounts
     WHERE service = $1 ORDER BY updated_at DESC`,
    [service]
  );
  return r.rows;
}

// ---------- Swish helpers ----------
function toSwishPayee(nummer) {
  if (nummer.startsWith("+46")) return nummer.slice(1);
  if (nummer.startsWith("07")) return "46" + nummer.slice(1);
  return nummer;
}

async function generateSwishQr({ account, amount, message }) {
  const payee = toSwishPayee(account);
  const body = {
    payee: { value: payee, editable: false },
    size: 512,
    border: 2,
    transparent: false,
    format: "png",
  };
  if (amount != null) body.amount = { value: amount, editable: false };
  if (message) body.message = { value: message, editable: true };

  const res = await fetch(
    "https://mpc.getswish.net/qrg-swish/api/v1/prefilled",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Swish QR API ${res.status}: ${text}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function normalizeSwishNumber(input) {
  if (!input) return null;
  const cleaned = input.replace(/[\s\-()]/g, "");
  let m = cleaned.match(/^\+467(\d{8})$/);
  if (m) return `+467${m[1]}`;
  m = cleaned.match(/^00467(\d{8})$/);
  if (m) return `+467${m[1]}`;
  m = cleaned.match(/^07(\d{8})$/);
  if (m) return `07${m[1]}`;
  m = cleaned.match(/^123(\d{7})$/);
  if (m) return `123${m[1]}`;
  return null;
}

// ---------- PayPal helpers ----------
function normalizePaypalAccount(input) {
  if (!input) return null;
  const trimmed = input.trim();

  // Email
  const emailMatch = trimmed.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  if (emailMatch) return trimmed.toLowerCase();

  // paypal.me URL or handle
  let handle = trimmed
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/^paypal\.me\//i, "")
    .replace(/^@/, "")
    .replace(/\/$/, "");

  if (/^[A-Za-z0-9_-]{1,20}$/.test(handle)) {
    return `@${handle}`;
  }
  return null;
}

function paypalDisplay(account) {
  if (!account) return "";
  if (account.startsWith("@")) return `paypal.me/${account.slice(1)}`;
  return account;
}

function paypalPayUrl(account, amount) {
  if (account.startsWith("@")) {
    const handle = account.slice(1);
    if (amount != null) {
      return `https://paypal.me/${handle}/${amount}`;
    }
    return `https://paypal.me/${handle}`;
  }
  return `mailto:${account}`;
}

async function generatePaypalQr({ account, amount }) {
  const url = paypalPayUrl(account, amount);
  return QRCode.toBuffer(url, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 512,
    color: { dark: "#003087", light: "#FFFFFF" },
  });
}

// ---------- Crypto wallet helpers ----------
const CRYPTO_VALIDATORS = {
  ethereum: (a) => /^0x[a-fA-F0-9]{40}$/.test(a) ? a : null,
  solana: (a) => (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) ? a : null),
  litecoin: (a) => {
    if (/^(ltc1)[0-9a-z]{6,87}$/i.test(a)) return a;
    if (/^[LM3][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(a)) return a;
    return null;
  },
};

const CRYPTO_URI_SCHEME = {
  ethereum: "ethereum",
  solana: "solana",
  litecoin: "litecoin",
};

function buildCryptoUri(coinKey, address, amount) {
  const scheme = CRYPTO_URI_SCHEME[coinKey];
  if (amount == null) return `${scheme}:${address}`;
  if (coinKey === "ethereum") {
    // ETH wants value in wei
    const wei = BigInt(Math.round(amount * 1e18)).toString();
    return `${scheme}:${address}?value=${wei}`;
  }
  return `${scheme}:${address}?amount=${amount}`;
}

async function generateCryptoQr({ coinKey, address, amount }) {
  const uri = buildCryptoUri(coinKey, address, amount);
  return QRCode.toBuffer(uri, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 512,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
}

function shortenAddress(addr) {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

// ---------- Service registry ----------
const SERVICES = {
  swish: {
    key: "swish",
    label: "Swish",
    color: SWISH_PINK,
    logoPath: SWISH_LOGO_PATH,
    logoName: "swish.png",
    accountFieldName: "nummer",
    accountWordSv: "nummer",
    accountWordSvDef: "numret",
    accountWordSvIndef: "ett nummer",
    formatHelp:
      "Ange ett svenskt mobilnummer (t.ex. 07X XXX XX XX eller +467X XXX XX XX) eller ett företags Swish-nummer (123 XXX XX XX).",
    normalize: normalizeSwishNumber,
    display: (acc) => acc,
    generateQr: generateSwishQr,
    showAmount: true,
    showMessage: true,
    qrInstruction: "Skanna QR-koden i Swish-appen för att betala.",
    amountSuffix: "SEK",
  },
  paypal: {
    key: "paypal",
    label: "PayPal",
    color: PAYPAL_BLUE,
    logoPath: PAYPAL_LOGO_PATH,
    logoName: "paypal.png",
    accountFieldName: "konto",
    accountWordSv: "konto",
    accountWordSvDef: "kontot",
    accountWordSvIndef: "ett konto",
    formatHelp:
      "Ange e (t.ex. namn@mail.com eller paypal.me/namn).",
    normalize: normalizePaypalAccount,
    display: paypalDisplay,
    generateQr: generatePaypalQr,
    showAmount: true,
    showMessage: false,
    qrInstruction: "Skanna QR-koden eller öppna länken för att betala.",
    amountSuffix: "USD",
  },
};

// Maps slash command name → { service, action }
const COMMAND_MAP = {};
for (const svc of Object.values(SERVICES)) {
  const p = `${svc.key}swap`;
  COMMAND_MAP[p] = { service: svc, action: "show" };
  COMMAND_MAP[`set${p}`] = { service: svc, action: "set" };
  COMMAND_MAP[`clear${p}`] = { service: svc, action: "clear" };
  COMMAND_MAP[`${p}list`] = { service: svc, action: "list" };
  COMMAND_MAP[`${p}remove`] = { service: svc, action: "remove" };
}

function isAdminAction(action) {
  return action === "list" || action === "remove";
}

// ---------- Bot ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", () => {
  console.log(`Inloggad som ${client.user.tag}`);
  client.user.setPresence({
    activities: [
      {
        name: "custom",
        type: ActivityType.Custom,
        state: "Nordic Swap — Built on trust.",
      },
    ],
    status: "online",
  });
});

async function sendConfirmPrompt(interaction, { prompt, customId }) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm:${customId}`)
      .setLabel("Ja, ta bort")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`cancel:${customId}`)
      .setLabel("Avbryt")
      .setStyle(ButtonStyle.Secondary)
  );
  return interaction.reply({
    content: prompt,
    components: [row],
    ephemeral: true,
  });
}



async function handleShow(interaction, svc) {
  const target = interaction.options.getUser("user") ?? interaction.user;
  const amount = svc.showAmount ? interaction.options.getNumber("belopp") : null;
  const message = svc.showMessage
    ? interaction.options.getString("meddelande")
    : null;
  const isSelf = target.id === interaction.user.id;
  const account = await getAccount(svc.key, target.id);

  if (!account) {
    return interaction.reply({
      content: isSelf
        ? `Du har inget registrerat ${svc.label}-${svc.accountWordSv}. Använd /set${svc.key}swap för att lägga till ${svc.accountWordSvIndef}.`
        : `${target.username} har inget registrerat ${svc.label}-${svc.accountWordSv}.`,
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  const qrBuffer = await svc.generateQr({ account, amount, message });
  const qrName = `${svc.key}-qr.png`;
  const qrFile = new AttachmentBuilder(qrBuffer, { name: qrName });
  const logo = new AttachmentBuilder(svc.logoPath, { name: svc.logoName });

  const fields = [
    {
      name: svc.label,
      value: `\`${svc.display(account)}\``,
      inline: true,
    },
  ];
  if (amount != null) {
    const fmt = (n) =>
      n.toLocaleString("sv-SE", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    const withSuffix = (n) =>
      svc.amountSuffix ? `${fmt(n)} ${svc.amountSuffix}` : fmt(n);
    const feeAmount = amount * (FEE_PERCENT / 100);
    const netAmount = amount - feeAmount;
    fields.push({ name: "Belopp", value: withSuffix(amount), inline: true });
    fields.push({
      name: `Avgift (${FEE_PERCENT}%)`,
      value: withSuffix(feeAmount),
      inline: true,
    });
    fields.push({ name: "Du får", value: withSuffix(netAmount), inline: true });
  }
  if (message) {
    fields.push({ name: "Meddelande", value: message, inline: false });
  }
  if (svc.key === "paypal") {
    fields.push({
      name: "Länk",
      value: paypalPayUrl(account, amount),
      inline: false,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(svc.color)
    .setTitle(`${svc.label} – ${target.username}`)
    .setDescription(svc.qrInstruction)
    .addFields(fields)
    .setThumbnail(`attachment://${svc.logoName}`)
    .setImage(`attachment://${qrName}`)
    .setFooter({
      text: `Begärt av ${interaction.user.username}`,
      iconURL: interaction.user.displayAvatarURL(),
    });

  return interaction.editReply({ embeds: [embed], files: [logo, qrFile] });
}

async function handleSet(interaction, svc, isAdmin) {
  const userId = interaction.user.id;
  const targetUserOpt = interaction.options.getUser("user");
  const settingForOther = targetUserOpt && targetUserOpt.id !== userId;

  if (settingForOther && !isAdmin) {
    return interaction.reply({
      content: `Endast administratörer kan spara ${svc.label}-${svc.accountWordSv} åt andra användare.`,
      ephemeral: true,
    });
  }

  const targetId = settingForOther ? targetUserOpt.id : userId;
  const targetLabel = settingForOther ? targetUserOpt.username : "Du";

  const existing = await getAccount(svc.key, targetId);
  if (existing) {
    return interaction.reply({
      content: settingForOther
        ? `${targetUserOpt.username} har redan ett registrerat ${svc.label}-${svc.accountWordSv}. Ta bort det med /${svc.key}swapremove innan du sparar nytt.`
        : `Du har redan ett registrerat ${svc.label}-${svc.accountWordSv}. Använd /clear${svc.key}swap för att ta bort det innan du registrerar ett nytt.`,
      ephemeral: true,
    });
  }

  const raw = interaction.options.getString(svc.accountFieldName);
  const normalized = svc.normalize(raw);
  if (!normalized) {
    return interaction.reply({
      content: `Ogiltigt ${svc.label}-${svc.accountWordSv}. ${svc.formatHelp}`,
      ephemeral: true,
    });
  }

  await setAccount(svc.key, targetId, normalized);
  return interaction.reply({
    content: settingForOther
      ? `${targetLabel}s ${svc.label}-${svc.accountWordSv} har sparats: **${svc.display(normalized)}**`
      : `Ditt ${svc.label}-${svc.accountWordSv} har sparats: **${svc.display(normalized)}**`,
    ephemeral: true,
  });
}

async function handleClear(interaction, svc) {
  const userId = interaction.user.id;
  const existing = await getAccount(svc.key, userId);
  if (!existing) {
    return interaction.reply({
      content: `Du har inget registrerat ${svc.label}-${svc.accountWordSv} att ta bort.`,
      ephemeral: true,
    });
  }
  return sendConfirmPrompt(interaction, {
    prompt: `Är du säker på att du vill ta bort ditt sparade ${svc.label}-${svc.accountWordSv} (\`${svc.display(existing)}\`)?`,
    customId: `clear:${svc.key}:${userId}:${interaction.user.id}`,
  });
}

async function handleRemove(interaction, svc) {
  const target = interaction.options.getUser("user", true);
  const existing = await getAccount(svc.key, target.id);
  if (!existing) {
    return interaction.reply({
      content: `${target.username} har inget registrerat ${svc.label}-${svc.accountWordSv}.`,
      ephemeral: true,
    });
  }
  return sendConfirmPrompt(interaction, {
    prompt: `Är du säker på att du vill ta bort **${target.username}**s ${svc.label}-${svc.accountWordSv} (\`${svc.display(existing)}\`)?`,
    customId: `remove:${svc.key}:${target.id}:${interaction.user.id}`,
  });
}

async function handleList(interaction, svc) {
  const rows = await listAccounts(svc.key);
  if (rows.length === 0) {
    return interaction.reply({
      content: `Inga ${svc.label}-${svc.accountWordSv} har registrerats ännu.`,
      ephemeral: true,
    });
  }

  const lines = await Promise.all(
    rows.map(async (row, i) => {
      let name = `Användare ${row.user_id}`;
      try {
        const u = await client.users.fetch(row.user_id);
        name = u.username;
      } catch {}
      const ts = Math.floor(new Date(row.updated_at).getTime() / 1000);
      return `**${i + 1}.** ${name} — \`${svc.display(row.account)}\` · uppdaterad <t:${ts}:R>`;
    })
  );

  const logo = new AttachmentBuilder(svc.logoPath, { name: svc.logoName });

  const chunks = [];
  let current = "";
  for (const line of lines) {
    if (current.length + line.length + 1 > 3800) {
      chunks.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + line;
  }
  if (current) chunks.push(current);

  const embeds = chunks.map((desc, idx) => {
    const e = new EmbedBuilder()
      .setColor(svc.color)
      .setDescription(desc)
      .setFooter({ text: `Totalt ${rows.length} registrerade konton` });
    if (idx === 0) {
      e.setTitle(`Registrerade ${svc.label}-konton`).setThumbnail(
        `attachment://${svc.logoName}`
      );
    }
    return e;
  });

  return interaction.reply({ embeds, files: [logo], ephemeral: true });
}

function cryptoServiceKey(coinKey) {
  return `crypto_${coinKey}`;
}

async function handleCryptoSwap(interaction, isAdmin) {
  const userId = interaction.user.id;
  const cmd = interaction.commandName;

  if (cmd === "setcryptoswap") {
    const coinKey = interaction.options.getString("valuta", true);
    const address = interaction.options.getString("adress", true).trim();
    const targetUserOpt = interaction.options.getUser("user");
    const settingForOther = targetUserOpt && targetUserOpt.id !== userId;

    if (settingForOther && !isAdmin) {
      return interaction.reply({
        content:
          "Endast administratörer kan spara kryptoadresser åt andra användare.",
        ephemeral: true,
      });
    }

    const targetId = settingForOther ? targetUserOpt.id : userId;
    const coin = CRYPTO_ASSETS[coinKey];
    const validated = CRYPTO_VALIDATORS[coinKey](address);
    if (!validated) {
      return interaction.reply({
        content: `Ogiltig ${coin.label}-adress. Kontrollera formatet och försök igen.`,
        ephemeral: true,
      });
    }

    const serviceKey = cryptoServiceKey(coinKey);
    const existing = await getAccount(serviceKey, targetId);
    if (existing) {
      return interaction.reply({
        content: settingForOther
          ? `${targetUserOpt.username} har redan en sparad ${coin.label}-adress. Ta bort den med /cryptoswapremove innan du sparar ny.`
          : `Du har redan en sparad ${coin.label}-adress. Använd /clearcryptoswap för att ta bort den först.`,
        ephemeral: true,
      });
    }

    await setAccount(serviceKey, targetId, validated);
    return interaction.reply({
      content: settingForOther
        ? `${targetUserOpt.username}s ${coin.label}-adress har sparats: \`${validated}\``
        : `Din ${coin.label}-adress har sparats: \`${validated}\``,
      ephemeral: true,
    });
  }

  if (cmd === "cryptoswap") {
    const coinKey = interaction.options.getString("valuta", true);
    const target = interaction.options.getUser("user") ?? interaction.user;
    const amount = interaction.options.getNumber("mängd");
    const isSelf = target.id === interaction.user.id;
    const coin = CRYPTO_ASSETS[coinKey];
    const address = await getAccount(cryptoServiceKey(coinKey), target.id);

    if (!address) {
      return interaction.reply({
        content: isSelf
          ? `Du har ingen sparad ${coin.label}-adress. Använd /setcryptoswap för att lägga till en.`
          : `${target.username} har ingen sparad ${coin.label}-adress.`,
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    const qrBuffer = await generateCryptoQr({
      coinKey,
      address,
      amount,
    });
    const qrFile = new AttachmentBuilder(qrBuffer, {
      name: `${coinKey}-qr.png`,
    });
    const logo = new AttachmentBuilder(coin.logoPath, { name: coin.logoName });

    const fields = [
      { name: "Valuta", value: `${coin.label} (${coin.symbol})`, inline: true },
      { name: "Adress", value: `\`${address}\``, inline: false },
    ];
    if (amount != null) {
      const fmtCoin = (n) =>
        `${n.toLocaleString("sv-SE", { maximumFractionDigits: 8 })} ${coin.symbol}`;
      const feeAmount = amount * (FEE_PERCENT / 100);
      const netAmount = amount - feeAmount;
      fields.push({ name: "Mängd", value: fmtCoin(amount), inline: true });
      fields.push({
        name: `Avgift (${FEE_PERCENT}%)`,
        value: fmtCoin(feeAmount),
        inline: true,
      });
      fields.push({ name: "Du får", value: fmtCoin(netAmount), inline: true });
    }

    const embed = new EmbedBuilder()
      .setColor(0xf7931a)
      .setTitle(`${coin.label} – ${target.username}`)
      .setDescription("Skanna QR-koden i din kryptoplånbok för att betala.")
    return interaction.editReply({ embeds: [embed], files: [logo, qrFile] });
  }

  if (cmd === "clearcryptoswap") {
    const coinKey = interaction.options.getString("valuta", true);
    const coin = CRYPTO_ASSETS[coinKey];
    const existing = await getAccount(cryptoServiceKey(coinKey), userId);
    if (!existing) {
      return interaction.reply({
        content: `Du har ingen sparad ${coin.label}-adress att ta bort.`,
        ephemeral: true,
      });
    }
    return sendConfirmPrompt(interaction, {
      prompt: `Är du säker på att du vill ta bort din sparade ${coin.label}-adress (\`${shortenAddress(existing)}\`)?`,
      customId: `clear:${cryptoServiceKey(coinKey)}:${userId}:${interaction.user.id}`,
    });
  }

  if (cmd === "cryptoswapremove") {
    const target = interaction.options.getUser("user", true);
    const coinKey = interaction.options.getString("valuta", true);
    const coin = CRYPTO_ASSETS[coinKey];
    const existing = await getAccount(cryptoServiceKey(coinKey), target.id);
    if (!existing) {
      return interaction.reply({
        content: `${target.username} har ingen sparad ${coin.label}-adress.`,
        ephemeral: true,
      });
    }
    return sendConfirmPrompt(interaction, {
      prompt: `Är du säker på att du vill ta bort **${target.username}**s ${coin.label}-adress (\`${shortenAddress(existing)}\`)?`,
      customId: `remove:${cryptoServiceKey(coinKey)}:${target.id}:${interaction.user.id}`,
    });
  }

  if (cmd === "cryptoswaplist") {
    const r = await pool.query(
      `SELECT user_id, service, account, updated_at FROM payment_accounts
       WHERE service LIKE 'crypto_%' ORDER BY user_id, service`
    );
    if (r.rows.length === 0) {
      return interaction.reply({
        content: "Inga kryptoadresser har registrerats ännu.",
        ephemeral: true,
      });
    }

    // Group by user
    const byUser = new Map();
    for (const row of r.rows) {
      if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
      byUser.get(row.user_id).push(row);
    }

    const userBlocks = await Promise.all(
      Array.from(byUser.entries()).map(async ([uid, rows]) => {
        let name = `Användare ${uid}`;
        try {
          const u = await client.users.fetch(uid);
          name = u.username;
        } catch {}
        const lines = rows.map((row) => {
          const coinKey = row.service.replace(/^crypto_/, "");
          const coin = CRYPTO_ASSETS[coinKey];
          return `• ${coin?.symbol ?? coinKey.toUpperCase()}: \`${shortenAddress(row.account)}\``;
        });
        return `**${name}**\n${lines.join("\n")}`;
      })
    );

    const chunks = [];
    let current = "";
    for (const block of userBlocks) {
      if (current.length + block.length + 2 > 3800) {
        chunks.push(current);
        current = "";
      }
      current += (current ? "\n\n" : "") + block;
    }
    if (current) chunks.push(current);

    const embeds = chunks.map((desc, idx) => {
      const e = new EmbedBuilder()
        .setColor(0xf7931a)
        .setDescription(desc)
        .setFooter({ text: `Totalt ${r.rows.length} adresser` });
      if (idx === 0) e.setTitle("Registrerade kryptoadresser");
      return e;
    });

    return interaction.reply({ embeds, ephemeral: true });
  }
}

async function handleCryptoCommand(interaction) {
  try {
    await interaction.deferReply();
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana,ethereum,litecoin&vs_currencies=usd,sek&include_24hr_change=true"
    );
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const data = await res.json();

    const fmt = (n, currency) =>
      new Intl.NumberFormat("sv-SE", {
        style: "currency",
        currency,
        maximumFractionDigits: 2,
      }).format(n);

    const arrow = (c) => (c >= 0 ? "▲" : "▼");
    const changeStr = (c) =>
      c == null ? "–" : `${arrow(c)} ${c.toFixed(2)}%`;

    const coins = [
      { id: "solana", name: "Solana", symbol: "SOL" },
      { id: "ethereum", name: "Ethereum", symbol: "ETH" },
      { id: "litecoin", name: "Litecoin", symbol: "LTC" },
    ];

    const fields = coins.map((c) => {
      const d = data[c.id] || {};
      const change = d.usd_24h_change;
      return {
        name: `${c.name} (${c.symbol})`,
        value: [
          `${fmt(d.usd ?? 0, "USD")} • ${fmt(d.sek ?? 0, "SEK")}`,
          `24h: ${changeStr(change)}`,
        ].join("\n"),
        inline: false,
      };
    });

    const embed = new EmbedBuilder()
      .setColor(0xf7931a)
      .setTitle("Kryptopriser")
      .addFields(fields)
      .setFooter({ text: "Källa: CoinGecko" })
      .setTimestamp(new Date());

    return interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error("Crypto command failed:", err);
    const msg = "Kunde inte hämta kryptopriser just nu. Försök igen senare.";
    if (interaction.deferred) return interaction.editReply({ content: msg });
    return interaction.reply({ content: msg, ephemeral: true });
  }
}

client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    const parts = interaction.customId.split(":");
    const action = parts[0];

    if (action === "cancel" || action === "confirm") {
      const operation = parts[1]; // "clear", "remove" or "clearhistorik"

      if (operation === "clearhistorik") {
        const targetId = parts[2];
        const initiatorId = parts[3];
        if (interaction.user.id !== initiatorId) {
          return interaction.reply({
            content: "Endast personen som startade åtgärden kan bekräfta den.",
            ephemeral: true,
          });
        }
        if (action === "cancel") {
          return interaction.update({
            content: "Åtgärden avbröts. Ingen historik raderades.",
            components: [],
          });
        }
        try {
          const res = await pool.query(
            `DELETE FROM trades WHERE exchanger_id = $1 OR customer_id = $1`,
            [targetId]
          );
          let name = `användaren`;
          try {
            const u = await client.users.fetch(targetId);
            name = u.username;
          } catch {}
          return interaction.update({
            content: `Historiken för ${name} har raderats (${res.rowCount} affär${res.rowCount === 1 ? "" : "er"}).`,
            components: [],
          });
        } catch (err) {
          console.error("Clear historik failed:", err);
          return interaction.update({
            content: "Ett oväntat fel inträffade. Försök igen.",
            components: [],
          });
        }
      }

      const serviceKey = parts[2];
      const targetId = parts[3];
      const initiatorId = parts[4];
      const svc = SERVICES[serviceKey];

      if (interaction.user.id !== initiatorId) {
        return interaction.reply({
          content: "Endast personen som startade åtgärden kan bekräfta den.",
          ephemeral: true,
        });
      }

      if (action === "cancel") {
        return interaction.update({
          content: "Åtgärden avbröts. Inget togs bort.",
          components: [],
        });
      }

      try {
        const removed = svc
          ? await clearAccount(svc.key, targetId)
          : false;
        if (!removed) {
          return interaction.update({
            content: "Inget konto hittades att ta bort.",
            components: [],
          });
        }
        const label = svc ? `${svc.label}-${svc.accountWordSv}` : "konto";
        const msg =
          operation === "remove"
            ? `Användarens ${label} har tagits bort.`
            : `Ditt ${label} har tagits bort.`;
        return interaction.update({ content: msg, components: [] });
      } catch (err) {
        console.error("Confirm action failed:", err);
        return interaction.update({
          content: "Ett oväntat fel inträffade. Försök igen.",
          components: [],
        });
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const REQUIRED_ROLE_ID = "1459902353145598105";

  let member;
  try {
    member = interaction.member?.roles?.cache
      ? interaction.member
      : await interaction.guild.members.fetch(interaction.user.id);
  } catch (err) {
    console.error("Kunde inte hämta medlem:", err);
  }

  const hasRole = member?.roles?.cache?.has(REQUIRED_ROLE_ID);

  if (!hasRole) {
    return interaction.reply({
      content: "Du har inte behörighet att använda detta kommando.",
      ephemeral: true,
    });
  }

  
  }
  if (interaction.commandName === "crypto") {
    return handleCryptoCommand(interaction);
  }

  if (
    [
      "setcryptoswap",
      "cryptoswap",
      "clearcryptoswap",
      "cryptoswaplist",
      "cryptoswapremove",
    ].includes(interaction.commandName)
  ) {
    let member = null;
    try {
      const guild = interaction.guild;
      if (guild) {
        member =
          interaction.member && interaction.member.roles?.cache
            ? interaction.member
            : await guild.members.fetch(interaction.user.id);
      }
    } catch (err) {
      console.error("Member fetch failed:", err);
    }
    
      });
    }

    try {
      return await handleCryptoSwap(interaction, isAdmin);
    } catch (err) {
      console.error("Crypto swap failed:", err);
      if (interaction.deferred && !interaction.replied) {
        return interaction.editReply({
          content: "Ett oväntat fel inträffade. Försök igen om en stund.",
          }).catch(() => {});
      }
      if (!interaction.replied && !interaction.deferred) {
        return interaction.reply({
          content: "Ett oväntat fel inträffade. Försök igen om en stund.",
          ephemeral: true,
        });
      }
    }
    return;
  }

  if (interaction.commandName === "donecrypto") {
    let member = null;
    try {
      const guild = interaction.guild;
      if (guild) {
        member =
          interaction.member && interaction.member.roles?.cache
            ? interaction.member
            : await guild.members.fetch(interaction.user.id);
      }
    } catch (err) {
      console.error("Member fetch failed:", err);
    }
    
      });
    }

    const coinKey = interaction.options.getString("valuta", true);
    const coin = CRYPTO_ASSETS[coinKey];
    const amount = interaction.options.getNumber("mängd");
    const customer = interaction.options.getUser("kund");
    const note = interaction.options.getString("notering");

    const fields = [
      { name: "Valuta", value: `${coin.label} (${coin.symbol})`, inline: true },
      { name: "Växlare", value: `<@${interaction.user.id}>`, inline: true },
    ];
    if (amount != null) {
      fields.push({
        name: "Mängd",
        value: `${amount.toLocaleString("sv-SE", { maximumFractionDigits: 8 })} ${coin.symbol}`,
        inline: true,
      });
    }
    if (customer) {
      fields.push({ name: "Kund", value: `<@${customer.id}>`, inline: true });
    }
    if (note) {
      fields.push({ name: "Notering", value: note, inline: false });
    }

    const logo = new AttachmentBuilder(coin.logoPath, { name: coin.logoName });

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle(`${coin.label} skickad`)
      .setDescription("Krypto har skickats till kunden.")
      .addFields(fields)
      .setThumbnail(`attachment://${coin.logoName}`)
      .setTimestamp(new Date());

    await logTrade({
      service: cryptoServiceKey(coinKey),
      exchangerId: interaction.user.id,
      customerId: customer?.id,
      amount,
      unit: coin.symbol,
      note,
    });

    return interaction.reply({
      content: customer ? `<@${customer.id}>` : undefined,
      embeds: [embed],
      files: [logo],
      allowedMentions: customer ? { users: [customer.id] } : { parse: [] },
    });
  }

  if (interaction.commandName === "historik") {
    let member = null;
    try {
      const guild = interaction.guild;
      if (guild) {
        member =
          interaction.member && interaction.member.roles?.cache
            ? interaction.member
            : await guild.members.fetch(interaction.user.id);
      }
    } catch (err) {
      console.error("Member fetch failed:", err);
    }
    
      });
    }

    const target = interaction.options.getUser("user", true);
    await interaction.deferReply({ ephemeral: true });

    const r = await pool.query(
      `SELECT service, exchanger_id, customer_id, amount, unit, note, created_at
         FROM trades
        WHERE exchanger_id = $1 OR customer_id = $1
        ORDER BY created_at DESC
        LIMIT 25`,
      [target.id]
    );

    if (r.rows.length === 0) {
      return interaction.editReply({
        content: `${target.username} har inga registrerade affärer.`,
      });
    }

    const totals = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE exchanger_id = $1) AS as_exchanger,
         COUNT(*) FILTER (WHERE customer_id = $1) AS as_customer
       FROM trades WHERE exchanger_id = $1 OR customer_id = $1`,
      [target.id]
    );
    const t = totals.rows[0];

    const sums = await pool.query(
      `SELECT unit, SUM(amount) AS total, COUNT(*) AS n
         FROM trades
        WHERE (exchanger_id = $1 OR customer_id = $1)
          AND amount IS NOT NULL AND unit IS NOT NULL
        GROUP BY unit
        ORDER BY unit`,
      [target.id]
    );

    const serviceLabel = (s) => {
      if (s === "swish") return "Swish";
      if (s === "paypal") return "PayPal";
      if (s.startsWith("crypto_")) {
        const k = s.replace(/^crypto_/, "");
        return CRYPTO_ASSETS[k]?.label ?? k;
      }
      return s;
    };

    const lines = r.rows.map((row) => {
      const date = new Date(row.created_at);
      const ts = `<t:${Math.floor(date.getTime() / 1000)}:f>`;
      const role =
        row.exchanger_id === target.id ? "Växlare" : "Kund";
      const counterpartyId =
        row.exchanger_id === target.id ? row.customer_id : row.exchanger_id;
      const counterparty = counterpartyId ? `<@${counterpartyId}>` : "—";
      const amountStr =
        row.amount != null
          ? `${Number(row.amount).toLocaleString("sv-SE", {
              maximumFractionDigits: 8,
            })}${row.unit ? ` ${row.unit}` : ""}`
          : "—";
      const noteStr = row.note ? `\n  *${row.note}*` : "";
      return `${ts} • **${serviceLabel(row.service)}** • ${role}\n  Belopp: ${amountStr} • Motpart: ${counterparty}${noteStr}`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`Historik – ${target.username}`)
      .setDescription(lines.join("\n\n").slice(0, 4000))
      .setFooter({
        text: `${t.as_exchanger} som växlare • ${t.as_customer} som kund • visar senaste ${r.rows.length}`,
      });

    if (sums.rows.length > 0) {
      const totalLines = sums.rows.map((row) => {
        const n = Number(row.total);
        const formatted = n.toLocaleString("sv-SE", {
          maximumFractionDigits: 8,
        });
        return `**${formatted} ${row.unit}** (${row.n} st)`;
      });
      embed.addFields({
        name: "Total omsättning",
        value: totalLines.join("\n"),
        inline: false,
      });
    }

    return interaction.editReply({ embeds: [embed] });
  }

  if (interaction.commandName === "rensahistorik") {
    let member = null;
    try {
      const guild = interaction.guild;
      if (guild) {
        member =
          interaction.member && interaction.member.roles?.cache
            ? interaction.member
            : await guild.members.fetch(interaction.user.id);
      }
    } catch (err) {
      console.error("Member fetch failed:", err);
    }
    
      });
    }

    const target = interaction.options.getUser("user", true);
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM trades
        WHERE exchanger_id = $1 OR customer_id = $1`,
      [target.id]
    );
    const count = r.rows[0].n;
    if (count === 0) {
      return interaction.reply({
        content: `${target.username} har ingen historik att rensa.`,
        ephemeral: true,
      });
    }

    return sendConfirmPrompt(interaction, {
      prompt: `Är du säker på att du vill rensa **${target.username}**s historik? ${count} affär${count === 1 ? "" : "er"} kommer raderas permanent.`,
      customId: `clearhistorik:${target.id}:${interaction.user.id}`,
    });
  }

  if (
    interaction.commandName === "doneswish" ||
    interaction.commandName === "donepaypal"
  ) {
    let member = null;
    try {
      const guild = interaction.guild;
      if (guild) {
        member =
          interaction.member && interaction.member.roles?.cache
            ? interaction.member
            : await guild.members.fetch(interaction.user.id);
      }
    } catch (err) {
      console.error("Member fetch failed:", err);
    }
    
        ephemeral: true,
      });
    }

    const svc =
      interaction.commandName === "doneswish"
        ? SERVICES.swish
        : SERVICES.paypal;

    const amount = interaction.options.getNumber("belopp");
    const customer = interaction.options.getUser("kund");
    const note = interaction.options.getString("notering");

    const fields = [
      {
        name: "Tjänst",
        value: svc.label,
        inline: true,
      },
      {
        name: "Växlare",
        value: `<@${interaction.user.id}>`,
        inline: true,
      },
    ];
    if (amount != null) {
      fields.push({
        name: "Belopp",
        value: `${amount.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${svc.amountSuffix}`,
        inline: true,
      });
    }
    if (customer) {
      fields.push({
        name: "Kund",
        value: `<@${customer.id}>`,
        inline: true,
      });
    }
    if (note) {
      fields.push({ name: "Notering", value: note, inline: false });
    }

    const logo = new AttachmentBuilder(svc.logoPath, { name: svc.logoName });

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle(`${svc.label}-betalning genomförd`)
      .setDescription("Affären har bekräftats som klar.")
      .addFields(fields)
      .setThumbnail(`attachment://${svc.logoName}`)
      .setTimestamp(new Date());

    await logTrade({
      service: svc.key,
      exchangerId: interaction.user.id,
      customerId: customer?.id,
      amount,
      unit: svc.amountSuffix || null,
      note,
    });

    return interaction.reply({
      content: customer ? `<@${customer.id}>` : undefined,
      embeds: [embed],
      files: [logo],
      allowedMentions: customer ? { users: [customer.id] } : { parse: [] },
    });
  }

  const mapped = COMMAND_MAP[interaction.commandName];
  if (!mapped) return;

  const requiredRoleId = isAdminAction(mapped.action)
    ? ADMIN_ROLE_ID
    : REQUIRED_ROLE_ID;

  let member = null;
  try {
    const guild = interaction.guild;
    if (guild) {
      member =
        interaction.member && interaction.member.roles?.cache
          ? interaction.member
          : await guild.members.fetch(interaction.user.id);
    }
  } catch (err) {
    console.error("Member fetch failed:", err);
  }

  
    });
  }

  try {
    switch (mapped.action) {
      case "show":
        return await handleShow(interaction, mapped.service);
      case "set":
        return await handleSet(interaction, mapped.service, isAdmin);
      case "clear":
        return await handleClear(interaction, mapped.service);
      case "remove":
        return await handleRemove(interaction, mapped.service);
      case "list":
        return await handleList(interaction, mapped.service);
    }
  } catch (err) {
    console.error("Command failed:", err);
    if (interaction.deferred && !interaction.replied) {
      return interaction.editReply({
        content: "Ett oväntat fel inträffade. Vänligen försök igen om en stund.",
      });
    }
    if (!interaction.replied) {
      return interaction.reply({
        content: "Ett oväntat fel inträffade. Vänligen försök igen om en stund.",
        ephemeral: true,
      });
    }
  }
});

if (!process.env.TOKEN) {
  console.error("Saknar TOKEN i miljövariabler.");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.log("Ingen databas – fortsätter utan DB");
}

ensureSchema()
  .then(() => client.login(process.env.TOKEN))
  .catch((err) => {
    console.error("Schema setup failed:", err);
    process.exit(1);
  });
