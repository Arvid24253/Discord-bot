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
        opt.setName("user").setDescription("Admin only").setRequired(false)
      ),

    (() => {
      const c = new SlashCommandBuilder()
        .setName(prefix)
        .setDescription(`Visa ${serviceLabel}`)
        .addUserOption((opt) =>
          opt.setName("user").setDescription("Vems konto").setRequired(false)
        );

      if (amountOption) {
        c.addNumberOption((opt) =>
          opt
            .setName("belopp")
            .setDescription(amountOption.description)
            .setRequired(false)
        );
      }

      if (messageOption) {
        c.addStringOption((opt) =>
          opt
            .setName("meddelande")
            .setDescription(messageOption.description)
            .setRequired(false)
        );
      }

      return c;
    })(),

    new SlashCommandBuilder()
      .setName(`clear${prefix}`)
      .setDescription(`Ta bort ditt ${serviceLabel}-konto`),

    new SlashCommandBuilder()
      .setName(`${prefix}list`)
      .setDescription(`Lista ${serviceLabel}-konton`),

    new SlashCommandBuilder()
      .setName(`${prefix}remove`)
      .setDescription(`Ta bort användares ${serviceLabel}`)
      .addUserOption((opt) =>
        opt.setName("user").setDescription("Vem").setRequired(true)
      ),
  ];

  return cmds;
}

const commands = [
  ...buildServiceCommands({
    prefix: "swishswap",
    serviceLabel: "Swish",
    accountFieldLabel: "nummer",
    accountFieldDescription: "Swish-nummer",
    amountOption: { description: "Belopp" },
    messageOption: { description: "Meddelande" },
  }),

  ...buildServiceCommands({
    prefix: "paypalswap",
    serviceLabel: "PayPal",
    accountFieldLabel: "konto",
    accountFieldDescription: "PayPal konto",
    amountOption: { description: "Belopp" },
    messageOption: null,
  }),

  new SlashCommandBuilder()
    .setName("crypto")
    .setDescription("Visa kryptopriser"),

  new SlashCommandBuilder()
    .setName("setcryptoswap")
    .setDescription("Spara crypto adress")
    .addStringOption((opt) =>
      opt
        .setName("valuta")
        .setDescription("Valuta")
        .setRequired(true)
        .addChoices(
          { name: "Solana", value: "solana" },
          { name: "Ethereum", value: "ethereum" },
          { name: "Litecoin", value: "litecoin" }
        )
    )
    .addStringOption((opt) =>
      opt.setName("adress").setDescription("Adress").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("cryptoswap")
    .setDescription("Visa crypto adress")
    .addStringOption((opt) =>
      opt
        .setName("valuta")
        .setDescription("Valuta")
        .setRequired(true)
        .addChoices(
          { name: "Solana", value: "solana" },
          { name: "Ethereum", value: "ethereum" },
          { name: "Litecoin", value: "litecoin" }
        )
    ),

  new SlashCommandBuilder()
    .setName("clearcryptoswap")
    .setDescription("Ta bort crypto adress")
    .addStringOption((opt) =>
      opt
        .setName("valuta")
        .setDescription("Valuta")
        .setRequired(true)
        .addChoices(
          { name: "Solana", value: "solana" },
          { name: "Ethereum", value: "ethereum" },
          { name: "Litecoin", value: "litecoin" }
        )
    ),

  new SlashCommandBuilder()
    .setName("cryptoswaplist")
    .setDescription("Lista crypto adresser"),

  new SlashCommandBuilder()
    .setName("cryptoswapremove")
    .setDescription("Ta bort crypto adress")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("Vem").setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("valuta")
        .setDescription("Valuta")
        .setRequired(true)
        .addChoices(
          { name: "Solana", value: "solana" },
          { name: "Ethereum", value: "ethereum" },
          { name: "Litecoin", value: "litecoin" }
        )
    ),

  new SlashCommandBuilder()
    .setName("donecrypto")
    .setDescription("Bekräfta crypto"),

  new SlashCommandBuilder()
  .setName("doneticket")
  .setDescription("Stäng ticketen och meddela användarna"),

  new SlashCommandBuilder()
    .setName("historik")
    .setDescription("Visa historik")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("Vem").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("rensahistorik")
    .setDescription("Rensa historik")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("Vem").setRequired(true)
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
              ? "Belopp i SEK"
              : "Belopp i USD"
          )
          .setMinValue(0)
          .setRequired(true)
      )
      .addUserOption((opt) =>
        opt
          .setName("kund")
          .setDescription("Kunden som affären gjordes med")
          .setRequired(false)
      )
      .addStringOption((opt) =>
        opt
          .setName("notering")
          .setDescription("Kort notering om affären")
          .setMaxLength(200)
          .setRequired(false)
      )
  ),
].map((c) => c.toJSON());

async function main() {
  const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(
      process.env.CLIENT_ID,
      process.env.GUILD_ID
    ),
    { body: commands }
  );

  console.log("Alla commands registrerade!");
}

main();