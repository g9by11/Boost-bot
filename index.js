/**
 * @author xql.dev
 * @github https://github.com/kirobotdev
 * @version 9.3.1
 * @example {token.txt} - {C'est un fichier texte qui contient les tokens des utilisateurs (un par ligne)}
 * @example {joined.json} - {C'est un fichier json qui contient les utilisateurs qui ont rejoint le serveur}
 */

const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN     = ''; // token de ton bot
const CLIENT_ID     = ''; // id de ton bot 
const CLIENT_SECRET = ''; // client secret de ton bot 
const REDIRECT_URI  = 'http://localhost'; // a mètre dans ton discord.dev sur ton redirect uri

const DELAY_BETWEEN_USERS  = 1500;
const RATELIMIT_RETRY_DELAY = 5000;

const JOINED_FILE = path.join(__dirname, 'joined.json');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function loadJoined() {
  if (!fs.existsSync(JOINED_FILE)) return { count: 0, users: [] };
  try {
    const data = JSON.parse(fs.readFileSync(JOINED_FILE, 'utf8'));
    return { count: data.count || 0, users: data.users || [] };
  } catch {
    return { count: 0, users: [] };
  }
}

function saveJoined(userId, guildId) {
  const data = loadJoined();
  const alreadySaved = data.users.find(u => u.id === userId && u.guild === guildId);
  if (!alreadySaved) {
    data.users.push({ id: userId, guild: guildId, joinedAt: new Date().toISOString() });
    data.count = data.users.length;
    fs.writeFileSync(JOINED_FILE, JSON.stringify(data, null, 2), 'utf8');
  }
}

function loadAllUsers() {
  const filePath = path.join(__dirname, 'token.txt');
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const results = [];
  for (const line of lines) {
    try {
      const token = line.split(':')[0] || line;
      if (token.includes('.')) {
        const id = Buffer.from(token.split('.')[0], 'base64').toString('utf8');
        results.push({ id, token });
      }
    } catch { }
  }
  return results;
}

async function resolveGuildId(input) {
  const trimmed = input.trim();

  if (/^\d{17,20}$/.test(trimmed)) return trimmed;

  const match = trimmed.match(/(?:discord\.gg\/|discord\.com\/invite\/|\/invite\/)([a-zA-Z0-9-]+)/);
  const code = match ? match[1] : trimmed;

  try {
    const res = await axios.get(`https://discord.com/api/v9/invites/${code}`, {
      headers: {
        'Authorization': `Bot ${BOT_TOKEN}`,
        'User-Agent': 'DiscordBot (https://discord.com, 9)'
      },
      timeout: 10000
    });
    return res.data?.guild?.id || null;
  } catch (err) {
    console.error(`[✗] resolveGuildId échoué pour "${code}":`, err.response?.status, err.response?.data?.message || err.message);
    return null;
  }
}

async function getOAuthToken(userToken) {
  const headers = {
    'Authorization': userToken,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'X-Super-Properties': Buffer.from(JSON.stringify({
      os: 'Windows', browser: 'Chrome', device: '',
      system_locale: 'fr-FR', browser_version: '120.0.0.0', os_version: '10',
      referrer: '', referring_domain: '', release_channel: 'stable',
      client_build_number: 260435
    })).toString('base64'),
    'X-Discord-Locale': 'fr',
    'Origin': 'https://discord.com',
    'Referer': `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=guilds.join%20identify`,
  };

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: 'guilds.join identify',
  });

  try {
    const authRes = await axios.post(
      `https://discord.com/api/v9/oauth2/authorize?${params.toString()}`,
      { authorize: true, permissions: '0' },
      { headers, timeout: 12000, maxRedirects: 0, validateStatus: s => s < 500 }
    );

    const location = authRes.data?.location || '';
    const codeMatch = location.match(/[?&]code=([^&]+)/);
    if (!codeMatch) {
      if (location.includes('error')) {
        console.log(`    [auth] Erreur OAuth2 : ${decodeURIComponent(location.split('error_description=')[1] || location)}`);
        return null; 
      }
      console.log(`    [auth] Pas de code dans la réponse :`, JSON.stringify(authRes.data).slice(0, 150));
      return null;
    }

    const code = codeMatch[1];

    const tokenRes = await axios.post(
      'https://discord.com/api/v9/oauth2/token',
      new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 12000
      }
    );

    const token = tokenRes.data?.access_token;
    if (token) {
      console.log(`    [auth] OK`);
      return token;
    }

  } catch (err) {
    if (err.response?.status === 429) return 'RATELIMIT';
    const reason = err.response
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 150)}`
      : `Réseau: ${err.code || err.message}`;
    console.log(`    [auth] Échec OAuth2 → ${reason}`);
    return null;
  }

  return null;
}

async function joinGuild(guildId, userId, accessToken) {
  try {
    const res = await axios.put(
      `https://discord.com/api/v9/guilds/${guildId}/members/${userId}`,
      { access_token: accessToken },
      {
        headers: {
          'Authorization': `Bot ${BOT_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    if (res.status === 201) return 'joined';
    if (res.status === 204) return 'already';
    return 'unknown';
  } catch (err) {
    if (err.response?.status === 429) return 'ratelimit';
    const status = err.response?.status;
    const msg = err.response?.data?.message || err.message;
    console.log(`    [join] Erreur HTTP ${status}: ${msg}`);
    if (status === 403) return 'forbidden';
    return 'error';
  }
}

async function getAvailableBoostSlots(userToken) {
  const headers = {
    'Authorization': userToken,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };
  try {
    const res = await axios.get('https://discord.com/api/v9/users/@me/guilds/premium/subscription-slots', { headers, timeout: 10000 });
    const slots = res.data;
    const availableSlots = slots.filter(slot => {
      const cooldownEnds = slot.cooldown_ends_at ? new Date(slot.cooldown_ends_at) : null;
      const isCooldownOver = !cooldownEnds || cooldownEnds < new Date();
      return !slot.canceled && isCooldownOver && !slot.premium_guild_subscription;
    });
    return availableSlots.map(s => s.id);
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) return [];
    console.log(`    [boost] Erreur fetch slots: ${err.response?.status || err.message}`);
    return [];
  }
}

async function boostGuildAPI(guildId, userToken, slotIds) {
  const headers = {
    'Authorization': userToken,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };
  try {
    const res = await axios.put(`https://discord.com/api/v9/guilds/${guildId}/premium/subscriptions`, {
      user_premium_guild_subscription_slot_ids: slotIds
    }, { headers, timeout: 10000 });
    return res.status === 201 || res.status === 200;
  } catch (err) {
    console.log(`    [boost] Erreur boost HTTP ${err.response?.status}: ${err.response?.data?.message || err.message}`);
    return false;
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('boost')
      .setDescription('Rejoint et boost le serveur avec les comptes ayant des boosts dispo')
      .addStringOption(opt =>
        opt.setName('invite')
          .setDescription('Lien d\'invitation, code ou ID du serveur')
          .setRequired(true)
      )
      .toJSON()
  ];
  const rest = new REST({ version: '9' }).setToken(BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('[✓] Commandes slash enregistrées');
  } catch (err) {
    console.error('[✗] Enregistrement commandes:', err.message);
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'boost') return;

  const inviteInput = interaction.options.getString('invite');
  await interaction.deferReply();

  const guildId = await resolveGuildId(inviteInput);
  if (!guildId) {
    return interaction.editReply('Impossible de résoudre le lien / l\'ID. Essaie avec l\'ID direct du serveur (ex: `1234567890`).');
  }

  const allUsers = loadAllUsers();
  console.log(`[*] ${allUsers.length} comptes à traiter → serveur ${guildId} (Action: ${interaction.commandName})`);

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setTitle('🚀 Boost en cours...')
      .setColor(0x000000)
      .setDescription(`Serveur : \`${guildId}\`\nComptes à traiter : **${allUsers.length}**`)
      .setTimestamp()
    ]
  });

  let joined = 0, already = 0, failed = 0, rateLimited = 0, totalBoosts = 0;

  for (let i = 0; i < allUsers.length; i++) {
    const user = allUsers[i];
    console.log(`[${i+1}/${allUsers.length}] Traitement de ${user.id}...`);

    if (i % 5 === 0 && i > 0) {
      const embed = new EmbedBuilder()
        .setTitle('🚀 Boost en cours...')
        .setColor(0x000000)
        .addFields(
          { name: '✅ Rejoints', value: `${joined}`, inline: true },
          { name: '🔄 Déjà membres', value: `${already}`, inline: true },
          { name: '❌ Échecs', value: `${failed}`, inline: true },
          { name: '⏳ Progression', value: `${i}/${allUsers.length}`, inline: true },
          { name: 'Sauvegardés', value: `${loadJoined().count}`, inline: true },
          { name: '💎 Boosts Appliqués', value: `${totalBoosts}`, inline: true }
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] }).catch(() => {});
    }

    let accessToken = await getOAuthToken(user.token);

    if (accessToken === 'RATELIMIT') {
      console.log(`  ⚠ Rate-limit auth pour ${user.id}, attente ${RATELIMIT_RETRY_DELAY}ms...`);
      rateLimited++;
      await sleep(RATELIMIT_RETRY_DELAY);
      accessToken = await getOAuthToken(user.token);
    }

    if (!accessToken || accessToken === 'RATELIMIT') {
      console.log(`  ✗ Auth OAuth2 échouée pour ${user.id}`);
      failed++;
      await sleep(DELAY_BETWEEN_USERS);
      continue;
    }

    console.log(`  ✓ Auth OK pour ${user.id}, tentative de join...`);

    let result = await joinGuild(guildId, user.id, accessToken);

    if (result === 'ratelimit') {
      console.log(`  ⚠ Rate-limit join pour ${user.id}, retry...`);
      rateLimited++;
      await sleep(RATELIMIT_RETRY_DELAY);
      result = await joinGuild(guildId, user.id, accessToken);
    }

    if (result === 'joined') {
      joined++;
      saveJoined(user.id, guildId);
      console.log(`  ✓ ${user.id} a rejoint ! (total sauvegardé: ${loadJoined().count})`);
    } else if (result === 'already') {
      already++;
      console.log(`  ~ ${user.id} déjà membre`);
    } else {
      failed++;
      console.log(`  ✗ ${user.id} échec join: ${result}`);
    }

    if (result === 'joined' || result === 'already') {
      const slotIds = await getAvailableBoostSlots(user.token);
      if (slotIds && slotIds.length > 0) {
        console.log(`  ✓ ${slotIds.length} boosts dispos pour ${user.id}, tentative de boost...`);
        const success = await boostGuildAPI(guildId, user.token, slotIds);
        if (success) {
          totalBoosts += slotIds.length;
          console.log(`  ✓ ${slotIds.length} boosts appliqués !`);
        } else {
          console.log(`  ✗ Échec de l'application des boosts pour ${user.id}`);
        }
      } else {
        console.log(`  - Aucun boost dispo pour ${user.id}`);
      }
    }

    await sleep(DELAY_BETWEEN_USERS);
  }

  const joinedData = loadJoined();

  const finalEmbed = new EmbedBuilder()
    .setTitle('✅ Boost terminé !')
    .setColor(0x000000)
    .addFields(
      { name: '✅ Nouveaux membres', value: `${joined}`, inline: true },
      { name: '🔄 Déjà membres', value: `${already}`, inline: true },
      { name: '❌ Échecs', value: `${failed}`, inline: true },
      { name: '⚠️ Rate-limits', value: `${rateLimited}`, inline: true },
      { name: 'Total dans joined.json', value: `${joinedData.count}`, inline: true },
      { name: '📊 Traités', value: `${allUsers.length}`, inline: true },
      { name: '💎 Boosts Appliqués', value: `${totalBoosts}`, inline: true }
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [finalEmbed] });
});

client.once('clientReady', async () => {
  console.log(`[✓] Bot connecté en tant que ${client.user.tag}`);
  await registerCommands();
  const users = loadAllUsers();
  console.log(`[*] ${users.length} comptes chargés depuis token.txt`);
  console.log(`[*] Commande : /boost <lien ou ID du serveur>`);
});

client.login(BOT_TOKEN);
