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

const REQUIRED_ROLE_ID = "1498733035548311796";
const ADMIN_ROLE_ID = "1498733035548311796";

if (!process.env.TOKEN) {
  console.error("Saknar TOKEN i miljövariabler.");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("Saknar DATABASE_URL i miljövariabler.");
  process.exit(1);
}

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

async function logTrade({ service, exchangerId, customerId, amount, unit, note }) {
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
    `INSERT INTO payment_accounts (user_id, service, account, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, service)
     DO UPDATE SET account = EXCLUDED.account, updated_at = NOW()`,
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

function normalizePaypalAccount(input) {
  if (!input) return null;
  const trimmed = input.trim();

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  const handle = trimmed
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
    return amount != null
      ? `https://paypal.me/${handle}/${amount}`
      : `https://paypal.me/${handle}`;
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

const CRYPTO_VALIDATORS = {
  ethereum: (a) => (/^0x[a-fA-F0-9]{40}$/.test(a) ? a : null),
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

const SERVICES = {
  swish: {
    key: "swish",
    label: "Swish",
    color: SWISH_PINK,
    logoPath: SWISH_LOGO_PATH,
    logoName: "swish.png",
    accountFieldName: "nummer",
    accountWordSv: "nummer",
    accountWordSvIndef: "ett nummer",
    formatHelp:
      "Ange ett svenskt mobilnummer, t.ex. 07X XXX XX XX, +467X XXX XX XX eller företagsnummer 123 XXX XX XX.",
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
    accountWordSvIndef: "ett konto",
    formatHelp:
      "Ange en PayPal e-postadress eller paypal.me-länk, t.ex. namn@mail.com eller paypal.me/namn.",
    normalize: normalizePaypalAccount,
    display: paypalDisplay,
    generateQr: generatePaypalQr,
    showAmount: true,
    showMessage: false,
    qrInstruction: "Skanna QR-koden eller öppna länken för att betala.",
    amountSuffix: "USD",
  },
};

const COMMAND_MAP = {};

for (const svc of Object.values(SERVICES)) {
  const p = `${svc.key}swap`;
  COMMAND_MAP[p] = { service: svc, action: "show" };
  COMMAND_MAP[`set${p}`] = { service: svc, action: "set" };
  COMMAND_MAP[`clear${p}`] = { service: svc, action: "clear" };
  COMMAND_MAP[`${p}list`] = { service: svc, action: "list" };
  COMMAND_MAP[`${p}remove`] = { service: svc, action: "remove" };
}

function memberHasRole(member, roleId) {
  return member?.roles?.cache?.has(roleId) ?? false;
}

function cryptoServiceKey(coinKey) {
  return `crypto_${coinKey}`;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

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

client.on("error", (err) => {
  console.error("Client error:", err);
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
        ? `${targetUserOpt.username} har redan ett registrerat ${svc.label}-${svc.accountWordSv}.`
        : `Du har redan ett registrerat ${svc.label}-${svc.accountWordSv}. Ta bort det först.`,
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

  const embed = new EmbedBuilder()
    .setColor(svc.color)
    .setTitle(`Registrerade ${svc.label}-konton`)
    .setDescription(lines.join("\n").slice(0, 4000))
    .setThumbnail(`attachment://${svc.logoName}`)
    .setFooter({ text: `Totalt ${rows.length} registrerade konton` });

  return interaction.reply({ embeds: [embed], files: [logo], ephemeral: true });
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
        content: "Endast administratörer kan spara kryptoadresser åt andra användare.",
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
          ? `${targetUserOpt.username} har redan en sparad ${coin.label}-adress.`
          : `Du har redan en sparad ${coin.label}-adress. Ta bort den först.`,
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
    const coin = CRYPTO_ASSETS[coinKey];
    const address = await getAccount(cryptoServiceKey(coinKey), target.id);

    if (!address) {
      return interaction.reply({
        content:
          target.id === interaction.user.id
            ? `Du har ingen sparad ${coin.label}-adress.`
            : `${target.username} har ingen sparad ${coin.label}-adress.`,
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    const qrBuffer = await generateCryptoQr({ coinKey, address, amount });
    const qrFile = new AttachmentBuilder(qrBuffer, { name: `${coinKey}-qr.png` });
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
      .addFields(fields)
      .setThumbnail(`attachment://${coin.logoName}`)
      .setImage(`attachment://${coinKey}-qr.png`)
      .setFooter({
        text: `Begärt av ${interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL(),
      });

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

    const lines = r.rows.map((row, i) => {
      const coinKey = row.service.replace(/^crypto_/, "");
      const coin = CRYPTO_ASSETS[coinKey];
      return `**${i + 1}.** <@${row.user_id}> — ${coin?.symbol ?? coinKey}: \`${shortenAddress(row.account)}\``;
    });

    const embed = new EmbedBuilder()
      .setColor(0xf7931a)
      .setTitle("Registrerade kryptoadresser")
      .setDescription(lines.join("\n").slice(0, 4000))
      .setFooter({ text: `Totalt ${r.rows.length} adresser` });

    return interaction.reply({ embeds: [embed], ephemeral: true });
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

    const coins = [
      { id: "solana", name: "Solana", symbol: "SOL" },
      { id: "ethereum", name: "Ethereum", symbol: "ETH" },
      { id: "litecoin", name: "Litecoin", symbol: "LTC" },
    ];

    const fields = coins.map((c) => {
      const d = data[c.id] || {};
      const change = d.usd_24h_change;
      const changeText =
        change == null ? "–" : `${change >= 0 ? "▲" : "▼"} ${change.toFixed(2)}%`;

      return {
        name: `${c.name} (${c.symbol})`,
        value: `${fmt(d.usd ?? 0, "USD")} • ${fmt(d.sek ?? 0, "SEK")}\n24h: ${changeText}`,
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

    if (interaction.deferred) {
      return interaction.editReply({ content: msg }).catch(() => {});
    }

    return interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
  }
}

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton()) {
      const parts = interaction.customId.split(":");
      const action = parts[0];

      if (action !== "cancel" && action !== "confirm") return;

      const operation = parts[1];

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

        const res = await pool.query(
          `DELETE FROM trades WHERE exchanger_id = $1 OR customer_id = $1`,
          [targetId]
        );

        return interaction.update({
          content: `Historiken har raderats (${res.rowCount} affär${res.rowCount === 1 ? "" : "er"}).`,
          components: [],
        });
      }

      const serviceKey = parts[2];
      const targetId = parts[3];
      const initiatorId = parts[4];

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

      const removed = await clearAccount(serviceKey, targetId);

      return interaction.update({
        content: removed
          ? "Kontot har tagits bort."
          : "Inget konto hittades att ta bort.",
        components: [],
      });
    }

    if (!interaction.isChatInputCommand()) return;
     if (interaction.commandName === "doneticket") {
       const channel = interaction.channel;

       if (!channel || !channel.deletable) {
         return interaction.reply({
           content: "Jag kan inte stänga den här ticketen.",
           ephemeral: true,
         });
       }

       const closer = interaction.user;

       // Försök hitta vem som öppnade ticketen
       // Rekommenderat: ticket creator ID sparas i channel.topic
       let openerId = channel.topic?.match(/\d{17,20}/)?.[0];

       let opener = null;
       if (openerId) {
         try {
           opener = await client.users.fetch(openerId);
         } catch {}
       }

       await interaction.reply({
         content: "✅ Ticketen markeras som klar och stängs om 5 sekunder.",
         ephemeral: true,
       });

       const messageToCloser =
         `✅ **Ticket complete**\n\n` +
         `Du stängde ticketen: **#${channel.name}**\n` +
         `Tack för hjälpen.`;

       const messageToOpener =
         `✅ **Ticket complete**\n\n` +
         `Din ticket **#${channel.name}** har blivit färdig och stängd.\n` +
         `Stängd av: **${closer.username}**`;

       try {
         await closer.send(messageToCloser);
       } catch {
         console.log("Kunde inte skicka DM till personen som stängde ticketen.");
       }

       if (opener) {
         try {
           await opener.send(messageToOpener);
         } catch {
           console.log("Kunde inte skicka DM till personen som öppnade ticketen.");
         }
       }

       setTimeout(async () => {
         try {
           await channel.delete(`Ticket completed by ${closer.tag}`);
         } catch (err) {
           console.error("Kunde inte ta bort ticket-kanalen:", err);
         }
       }, 5000);

       return;
     }
    let member = null;

    if (interaction.guild) {
      member =
        interaction.member && interaction.member.roles?.cache
          ? interaction.member
          : await interaction.guild.members.fetch(interaction.user.id);
    }

    const hasRequiredRole = memberHasRole(member, REQUIRED_ROLE_ID);
    const isAdmin = memberHasRole(member, ADMIN_ROLE_ID);

    if (!hasRequiredRole) {
      return interaction.reply({
        content: "Du har inte behörighet att använda detta kommando.",
        ephemeral: true,
      });
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
      return handleCryptoSwap(interaction, isAdmin);
    }

    if (interaction.commandName === "donecrypto") {
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
          value: `${amount.toLocaleString("sv-SE", {
            maximumFractionDigits: 8,
          })} ${coin.symbol}`,
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

      const lines = r.rows.map((row) => {
        const ts = `<t:${Math.floor(
          new Date(row.created_at).getTime() / 1000
        )}:f>`;

        const amountStr =
          row.amount != null
            ? `${Number(row.amount).toLocaleString("sv-SE", {
                maximumFractionDigits: 8,
              })}${row.unit ? ` ${row.unit}` : ""}`
            : "—";

        return `${ts} • **${row.service}**\nBelopp: ${amountStr}`;
      });

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`Historik – ${target.username}`)
        .setDescription(lines.join("\n\n").slice(0, 4000));

      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "rensahistorik") {
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
      const svc =
        interaction.commandName === "doneswish" ? SERVICES.swish : SERVICES.paypal;

      const amount = interaction.options.getNumber("belopp");
      const customer = interaction.options.getUser("kund");
      const note = interaction.options.getString("notering");

      const fields = [
        { name: "Tjänst", value: svc.label, inline: true },
        { name: "Växlare", value: `<@${interaction.user.id}>`, inline: true },
      ];

      if (amount != null) {
        fields.push({
          name: "Belopp",
          value: `${amount.toLocaleString("sv-SE", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })} ${svc.amountSuffix}`,
          inline: true,
        });
      }

      if (customer) {
        fields.push({ name: "Kund", value: `<@${customer.id}>`, inline: true });
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

    switch (mapped.action) {
      case "show":
        return handleShow(interaction, mapped.service);
      case "set":
        return handleSet(interaction, mapped.service, isAdmin);
      case "clear":
        return handleClear(interaction, mapped.service);
      case "remove":
        return handleRemove(interaction, mapped.service);
      case "list":
        return handleList(interaction, mapped.service);
      default:
        return;
    }
  } catch (err) {
    console.error("Interaction failed:", err);

    if (interaction.deferred && !interaction.replied) {
      return interaction
        .editReply({
          content: "Ett oväntat fel inträffade. Försök igen om en stund.",
        })
        .catch(() => {});
    }

    if (!interaction.replied && !interaction.deferred) {
      return interaction
        .reply({
          content: "Ett oväntat fel inträffade. Försök igen om en stund.",
          ephemeral: true,
        })
        .catch(() => {});
    }
  }
});

ensureSchema()
  .then(() => client.login(process.env.TOKEN))
  .catch((err) => {
    console.error("Schema setup failed:", err);
    process.exit(1);
  });