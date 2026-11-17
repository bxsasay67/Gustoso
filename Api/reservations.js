import { Redis } from '@upstash/redis'

// ─────────────────────────────────────────────────────────────
//  Réglages
// ─────────────────────────────────────────────────────────────
const CAPACITE = 50 // places par service (midi / soir)
const HORAIRES = {
  lundi: [['11:00', '15:00']],
  mardi: [['11:00', '15:00'], ['18:00', '22:30']],
  mercredi: [['11:00', '15:00'], ['18:00', '22:30']],
  jeudi: [['11:00', '15:00'], ['18:00', '22:30']],
  vendredi: [['10:00', '15:00'], ['18:00', '23:00']],
  samedi: [['11:30', '15:00'], ['18:00', '23:00']],
  dimanche: [['11:30', '15:30'], ['18:00', '22:30']],
}
const SERVICES = ['midi', 'soir']
const EXPIRATION = 60 * 60 * 24 * 120 // 120 jours
// La clé staff est dans la variable d'environnement Vercel STAFF_KEY (jamais dans le code : le dépôt est public).

// ─────────────────────────────────────────────────────────────
const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m }
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
const jourDe = (date) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Intl.DateTimeFormat('fr-CH', { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d, 12)))
}
const slotsDe = (date) => HORAIRES[jourDe(date)] || []
const serviceDe = (date, heure) => slotsDe(date).findIndex(([a, b]) => toMin(heure) >= toMin(a) && toMin(heure) <= toMin(b) - 30)
const zurich = (opts, d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', ...opts }).format(d)
const aujourdhui = () => zurich({})
const dansJours = (n) => zurich({}, new Date(Date.now() + n * 864e5))
const maintenantMin = () => toMin(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Zurich' }).format(new Date()))
const clePlaces = (date, i) => `places:${date}:${SERVICES[i]}`
const cleListe = (date) => `resa:${date}`

let client
function db() {
  if (!client) {
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
    if (!url || !token) throw new Error('Base de données non connectée')
    client = new Redis({ url, token })
  }
  return client
}

function estStaff(req) {
  const key = process.env.STAFF_KEY
  return !!key && String(req.headers['x-staff-key'] || '').trim() === key.trim()
}

async function lireListe(date) {
  const brut = await db().lrange(cleListe(date), 0, -1)
  return { brut, resas: brut.map((x) => (typeof x === 'string' ? JSON.parse(x) : x)) }
}

// ─────────────────────────────────────────────────────────────
//  GET  /api/reservations?date=…            → places restantes (public)
//  GET  /api/reservations?date=…&staff=1    → liste complète (clé staff)
//  POST /api/reservations { action:'reserve', … }          → réserver (public)
//  POST /api/reservations { action:'cancel', date, id }    → annuler (clé staff)
// ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  try {
    if (req.method === 'GET') {
      const date = req.query.date
      if (!isDate(date)) return res.status(400).json({ error: 'Date invalide.' })
      const slots = slotsDe(date)
      const pris = await Promise.all(slots.map((_, i) => db().get(clePlaces(date, i))))
      const services = slots.map((s, i) => {
        const p = Number(pris[i] || 0)
        return { service: SERVICES[i], horaire: s.join('–'), pris: p, restantes: Math.max(0, CAPACITE - p), capacite: CAPACITE }
      })
      if (req.query.staff) {
        if (!estStaff(req)) return res.status(401).json({ error: 'Clé incorrecte.' })
        const { resas } = await lireListe(date)
        return res.status(200).json({ date, jour: jourDe(date), services, reservations: resas.sort((a, b) => a.heure.localeCompare(b.heure)) })
      }
      return res.status(200).json({ date, jour: jourDe(date), services: services.map(({ pris, ...s }) => s) })
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée.' })
    const b = req.body || {}

    // ── Annulation (staff) ──
    if (b.action === 'cancel') {
      if (!estStaff(req)) return res.status(401).json({ error: 'Clé incorrecte.' })
      if (!isDate(b.date)) return res.status(400).json({ error: 'Date invalide.' })
      const { brut, resas } = await lireListe(b.date)
      const idx = resas.findIndex((r) => r.id === b.id)
      if (idx < 0) return res.status(404).json({ error: 'Réservation introuvable.' })
      const r = resas[idx]
      await db().lrem(cleListe(b.date), 1, brut[idx])
      const s = SERVICES.indexOf(r.service)
      const reste = await db().decrby(clePlaces(b.date, s), r.personnes)
      if (reste < 0) await db().set(clePlaces(b.date, s), 0)
      return res.status(200).json({ ok: true })
    }

    // ── Réservation (public) ──
    const date = b.date
    const heure = String(b.heure || '')
    const personnes = Number(b.personnes)
    const nom = String(b.nom || '').trim().slice(0, 80)
    const tel = String(b.tel || '').trim().slice(0, 30)
    const placement = String(b.placement || 'Peu importe').slice(0, 20)
    const remarque = String(b.remarque || '').trim().slice(0, 300)

    if (!isDate(date) || date < aujourdhui() || date > dansJours(92)) return res.status(400).json({ error: 'Date invalide.' })
    if (!/^\d{2}:\d{2}$/.test(heure)) return res.status(400).json({ error: 'Heure invalide.' })
    if (!Number.isInteger(personnes) || personnes < 1 || personnes > CAPACITE) return res.status(400).json({ error: `Entre 1 et ${CAPACITE} personnes.` })
    if (!nom) return res.status(400).json({ error: 'Indiquez votre nom.' })
    if (tel.replace(/\D/g, '').length < 9) return res.status(400).json({ error: 'Numéro de téléphone invalide.' })
    const i = serviceDe(date, heure)
    if (i < 0) return res.status(400).json({ error: `Le restaurant n’accueille pas de table à cette heure-là le ${jourDe(date)}.` })
    if (date === aujourdhui() && toMin(heure) < maintenantMin() + 30)
      return res.status(400).json({ error: 'Pour une table dans moins de 30 minutes, appelez le 021 728 27 49.' })

    const key = clePlaces(date, i)
    const total = await db().incrby(key, personnes) // atomique
    if (total > CAPACITE) {
      await db().decrby(key, personnes)
      const restantes = Math.max(0, CAPACITE - (total - personnes))
      return res.status(409).json({
        error: restantes === 0
          ? `Complet pour le service du ${SERVICES[i]} ce jour-là. Choisissez un autre service ou une autre date.`
          : `Il ne reste que ${restantes} place${restantes > 1 ? 's' : ''} pour le service du ${SERVICES[i]} ce jour-là.`,
        restantes,
      })
    }
    await db().expire(key, EXPIRATION)
    const id = Math.random().toString(36).slice(2, 7).toUpperCase()
    await db().rpush(cleListe(date), JSON.stringify({ id, date, heure, service: SERVICES[i], personnes, placement, nom, tel, remarque, creee: new Date().toISOString() }))
    await db().expire(cleListe(date), EXPIRATION)
    return res.status(200).json({ ok: true, id, restantes: CAPACITE - total })
  } catch (e) {
    console.error(e)
    return res.status(500).json({ error: 'Service indisponible pour le moment. Appelez le 021 728 27 49.' })
  }
}
