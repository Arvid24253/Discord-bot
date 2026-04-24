require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

function buildServiceCommands({
  prefix,
  serviceLabel,
  accountFieldLabel,
  accountFieldDescription,
  amountOption,
  messageOption,
}) {
  const cmds = [
    new SlashCommandBuilder()
      .setName(`set${prefix}`)
      .setDescription(`Spara ett ${serviceLabel}-konto`)
      .addStringOption((opt) =>
        opt
          .setName(accountFieldLabel)
          .setDescription(accountFieldDescription)
          .setRequired(true)
      )
      .addUserOption((opt) =>
        opt
          .setName("user")
          .setDescription("Endast admin: spara åt en annan användare")
          .setRequired(false)
      ),
    (() => {
      const c = new SlashCommandBuilder()
        .setName(prefix)
        .setDescription(`Visa ett sparat ${serviceLabel}-konto med QR-kod`)
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Vems konto ska visas (utelämna för ditt eget)")
            .setRequired(false)
        );
      if (amountOption) {
        c.addNumberOption((opt) =>
          opt
            .setName("belopp")
            .setDescription(amountOption.description)
            .setMinValue(amountOption.min ?? 1)
            .setMaxValue(amountOption.max ?? 150000)
            .setRequired(false)
        );
      }
      if (messageOption) {
        c.addStringOption((opt) =>
          opt
            .setName("meddelande")
            .setDescription(messageOption.description)
            .setMaxLength(50)
            .setRequired(false)
        );
      }
      return c;
    })(),
    new SlashCommandBuilder()
      .setName(`clear${prefix}`)
      .setDescription(`Ta bort ditt sparade ${serviceLabel}-konto`),
    new SlashCommandBuilder()
      .setName(`${prefix}list`)
      .setDescription(`Visa alla registrerade ${serviceLabel}-konton`),
    new SlashCommandBuilder()
      .setName(`${prefix}remove`)
      .setDescription(`Ta bort en användares sparade ${serviceLabel}-konto`)
      .addUserOption((opt) =>
        opt
          .setName("user")
          .setDescription("Vems konto ska tas bort")
          .setRequired(true)
      ),
  ];
  return cmds;
}

const commands = [
  ...buildServiceCommands({
    prefix: "swishswap",
    serviceLabel: "Swish",
    accountFieldLabel: "nummer",
    accountFieldDescription: "Swish-numret som ska sparas",
    amountOption: { description: "Förinställt belopp i SEK (valfritt)" },
    messageOption: { description: "Meddelande till mottagaren (valfritt)" },
  }),
  ...buildServiceCommands({
    prefix: "paypalswap",
    serviceLabel: "PayPal",
    accountFieldLabel: "konto",
    accountFieldDescription:
      "PayPal e-post eller paypal.me-länk (t.ex. namn@mail.com eller paypal.me/namn)",
    amountOption: { description: "Förinställt belopp (valfritt)", max: 100000 },
    messageOption: null,
  }),
  new SlashCommandBuilder()
    .setName("crypto")
    .setDescription("Visa aktuellt pris på Solana, Ethereum och Litecoin"),
  new SlashCommandBuilder()
    .setName("setcryptoswap")
    .setDescription("Spara en kryptoadress för en vald valuta")
    .addStringOption((opt) =>
      opt
        .setName("valuta")
        .setDescription("Vilken kryptovaluta")
        .setRequired(true)
        .addChoices(
          { name: "Solana (SOL)", value: "solana" },
          { name: "Ethereum (ETH)", value: "ethereum" },
          { name: "Litecoin (LTC)", value: "litecoin" }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName("adress")
        .setDescription("Plånboksadressen som ska sparas")
        .setRequired(true)
    )
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("Endast admin: spara åt en annan användare")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("cryptoswap")
    .setDescription("Visa en sparad kryptoadress med QR-kod")
    .addStringOption((opt) =>
      opt
        .setName("valuta")
        .setDescription("Vilken kryptovaluta")
        .setRequired(true)
        .addChoices(
          { name: "Solana (SOL)", value: "solana" },
          { name: "Ethereum (ETH)", value: "ethereum" },
          { name: "Litecoin (LTC)", value: "litecoin" }
        )
    )
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("Vems adress ska visas (utelämna för din egen)")
        .setRequired(false)
    )
    .addNumberOption((opt) =>
      opt
        .setName("mängd")
        .setDescription("Förinställt belopp (valfritt)")
        .setMinValue(0)
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("clearcryptoswap")
    .setDescription("Ta bort din sparade kryptoadress för en valuta")
    .addStringOption((opt) =>
      opt
        .setName("valuta")
        .setDescription("Vilken kryptovaluta")
        .setRequired(true)
        .addChoices(
          { name: "Solana (SOL)", value: "solana" },
          { name: "Ethereum (ETH)", value: "ethereum" },
          { name: "Litecoin (LTC)", value: "litecoin" }
        )
    ),
  new SlashCommandBuilder()
    .setName("cryptoswaplist")
    .setDescription("Visa alla registrerade kryptoadresser"),
  new SlashCommandBuilder()
    .setName("cryptoswapremove")
    .setDescription("Ta bort en användares sparade kryptoadress")
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("Vems adress ska tas bort")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("valuta")
        .setDescription("Vilken kryptovaluta")
        .setRequired(true)
        .addChoices(
          { name: "Solana (SOL)", value: "solana" },
          { name: "Ethereum (ETH)", value: "ethereum" },
          { name: "Litecoin (LTC)", value: "litecoin" }
        )
    ),
  new SlashCommandBuilder()
    .setName("donecrypto")
    .setDescription("Bekräfta att en kryptobetalning har skickats till kunden")
    .addStringOption((opt) =>
      opt
        .setName("valuta")
        .setDescription("Vilken kryptovaluta som skickades")
        .setRequired(true)
        .addChoices(
          { name: "Solana (SOL)", value: "solana" },
          { name: "Ethereum (ETH)", value: "ethereum" },
          { name: "Litecoin (LTC)", value: "litecoin" }
        )
    )
    .addNumberOption((opt) =>
      opt
        .setName("mängd")
        .setDescription("Mängd som skickades (valfritt)")
        .setMinValue(0)
        .setRequired(false)
    )
    .addUserOption((opt) =>
      opt
        .setName("kund")
        .setDescription("Kunden som affären gjordes med (valfritt)")
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("notering")
        .setDescription("Kort notering om affären (valfritt)")
        .setMaxLength(200)
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("historik")
    .setDescription("Visa en användares senaste affärer (endast admin)")
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("Vems historik ska visas")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("rensahistorik")
    .setDescription("Rensa en användares affärshistorik (endast admin)")
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("Vems historik ska rensas")
        .setRequired(true)
    ),
  ...["doneswish", "donepaypal"].map((name) =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription(
        name === "doneswish"
          ? "Bekräfta att en Swish-betalning har gått igenom"
          : "Bekräfta att en PayPal-betalning har gått igenom"
      )
      .addNumberOption((opt) =>
        opt
          .setName("belopp")
          .setDescription(
            name === "doneswish"
              ? "Belopp i SEK (valfritt)"
              : "Belopp i USD (valfritt)"
          )
          .setMinValue(0)
          .setRequired(false)
      )
      .addUserOption((opt) =>
        opt
          .setName("kund")
          .setDescription("Kunden som affären gjordes med (valfritt)")
          .setRequired(false)
      )
      .addStringOption((opt) =>
        opt
          .setName("notering")
          .setDescription("Kort notering om affären (valfritt)")
          .setMaxLength(200)
          .setRequired(false)
      )
  ),
].map((c) => c.toJSON());

async function main() {
  const token = process.env.TOKEN;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;

  if (!token || !clientId) {
    console.error("Saknar TOKEN eller CLIENT_ID.");
    process.exit(1);
  }

  const rest = new REST({ version: "10" }).setToken(token);

  try {
    if (guildId) {
      console.log(`Registrerar kommandon i guild ${guildId}...`);
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: commands,
      });
      console.log("Klar (guild).");
    } else {
      console.log("Registrerar globala kommandon...");
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log("Klar (globalt). Kan ta upp till en timme att synas.");
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

main();
