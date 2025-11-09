<template>
  <div style="max-width:800px;margin:2rem auto;font-family:Arial,Helvetica,sans-serif">
    <h1>Spotify Dashboard</h1>

    <div style="margin-bottom:1rem">
      <button @click="openLogin">Connect Spotify</button>
    </div>

    <div style="margin-bottom:1rem">
      <div v-if="!spotifyUserId">
        <small>Not connected</small>
      </div>
      <div v-else>
        <small>Connected</small>
        <button @click="signOut" style="margin-left:8px">Sign out</button>
      </div>
    </div>

  <artists-list :artists="artists" :total="followingTotal" v-if="artists.length" />

    <div v-if="artists.length" style="margin-top:1rem">
      <h3>Playback controls</h3>

      <div v-if="currentTrack" style="display:flex;align-items:center;margin-bottom:8px">
        <img v-if="currentTrack.image" :src="currentTrack.image" width="64" height="64" style="margin-right:8px" />
        <div>
          <div style="font-weight:700">Now playing</div>
          <div>{{ currentTrack.name }} — {{ currentTrack.artists }}</div>
          <div style="font-size:12px;color:#666">{{ currentTrack.album }}</div>
        </div>
      </div>

      <div>
        <label>Play top track (1-10):</label>
        <input type="number" v-model.number="playIndexDisplay" min="1" max="10" style="width:4rem;margin-left:6px" />
        <button v-if="!isPlaying" @click="playTop" style="margin-left:8px">Play</button>
        <button v-else @click="stopPlayback" style="margin-left:8px">Stop currently playing song</button>
      </div>
    </div>

    <pre v-if="error" style="color:red">{{ error }}</pre>
  </div>
</template>

<script>
import ArtistsList from './components/ArtistsList.vue'

export default {
  components: { ArtistsList },
  data() {
    return {
      apiBase: import.meta.env.VITE_API_BASE || 'https://9h1uaki641.execute-api.ap-south-1.amazonaws.com/Prod',
      spotifyUserId: localStorage.getItem('spotifyUserId') || new URLSearchParams(window.location.search).get('spotifyUserId') || '',
      artists: [],
      // internal 0-based index
      playIndex: 0,
      // 1-based input shown to user
      playIndexDisplay: 1,
      error: null,
      player: null,
      deviceId: null,
      tokenInfo: null,
      currentTrack: null,
      isPlaying: false
    }
  },
  mounted() {
    // If user arrived via OAuth (query param), persist the spotifyUserId
    const qs = new URLSearchParams(window.location.search)
    const qId = qs.get('spotifyUserId')
    if (qId) {
      this.spotifyUserId = qId
      localStorage.setItem('spotifyUserId', qId)
      // clean the URL
      history.replaceState(null, '', window.location.pathname)
    }

    if (this.spotifyUserId) {
      this.fetchFollowing()
      // try to sync playback state
      this.fetchCurrentPlayback().catch(()=>{})
    }
  },
  methods: {
    openLogin() {
      window.location.href = this.apiBase + '/auth/spotify/login'
    },
    async fetchFollowing() {
      this.error = null
      try {
        const res = await fetch(`${this.apiBase}/spotify/following?spotifyUserId=${this.spotifyUserId}`)
        if (!res.ok) throw new Error(await res.text())
        const json = await res.json()
        // Spotify's following endpoint returns an object with artists and a total nested
        this.artists = json.artists && json.artists.items ? json.artists.items : []
        // store total if provided
        this.followingTotal = (json.artists && json.artists.total) || (json.total || this.artists.length)
      } catch (err) {
        this.error = err.message
      }
    },
    signOut() {
      localStorage.removeItem('spotifyUserId')
      this.spotifyUserId = ''
      this.artists = []
      this.currentTrack = null
      this.isPlaying = false
      this.tokenInfo = null
      if (this.player) {
        try { this.player.disconnect() } catch (e) {}
        this.player = null
      }
    },
    async stopPlayback() {
      this.error = null
      try {
        if (this.player && this.deviceId) {
          await this.player.pause()
          this.isPlaying = false
          return
        }
        const res = await fetch(`${this.apiBase}/spotify/player/stop?spotifyUserId=${this.spotifyUserId}`, { method: 'PUT' })
        if (!res.ok) throw new Error(await res.text())
        await this.fetchCurrentPlayback()
      } catch (err) {
        this.error = err.message
      }
    },
    async loadSpotifySdk() {
      if (window.Spotify) return
      return new Promise((resolve, reject) => {
        const s = document.createElement('script')
        s.src = 'https://sdk.scdn.co/spotify-player.js'
        s.onload = () => resolve()
        s.onerror = reject
        document.head.appendChild(s)
      })
    },
    async ensureToken() {
      if (this.tokenInfo && Date.now() < (this.tokenInfo.fetchedAt + (this.tokenInfo.expires_in - 30) * 1000)) return this.tokenInfo.access_token
      const res = await fetch(`${this.apiBase}/spotify/player/token?spotifyUserId=${this.spotifyUserId}`)
      if (!res.ok) throw new Error(await res.text())
      const json = await res.json()
      this.tokenInfo = { access_token: json.access_token, expires_in: json.expires_in, fetchedAt: Date.now() }
      return this.tokenInfo.access_token
    },
    async createPlayer() {
      if (this.player) return this.player
      await this.loadSpotifySdk()
      const accessToken = await this.ensureToken()

      this.player = new window.Spotify.Player({
        name: 'Cactro Web Player',
        getOAuthToken: cb => { cb(this.tokenInfo.access_token) }
      })

      this.player.addListener('initialization_error', ({ message }) => { this.error = message })
      this.player.addListener('authentication_error', ({ message }) => { this.error = message })
      this.player.addListener('account_error', ({ message }) => { this.error = message })
      this.player.addListener('playback_error', ({ message }) => { this.error = message })

      this.player.addListener('ready', ({ device_id }) => {
        this.deviceId = device_id
        console.log('Web Playback SDK ready, device id', device_id)
      })

      this.player.addListener('player_state_changed', (state) => {
        if (!state) {
          this.isPlaying = false
          this.currentTrack = null
          return
        }
        this.isPlaying = !state.paused
        try {
          const t = state.track_window && state.track_window.current_track
          if (t) this.currentTrack = { name: t.name, artists: t.artists.map(a => a.name).join(', '), album: t.album && t.album.name, image: t.album && t.album.images && t.album.images[0] && t.album.images[0].url }
        } catch (e) {}
      })

      await this.player.connect()
      return this.player
    },
    async playTop() {
      this.error = null
      try {
        if (!this.spotifyUserId) throw new Error('Missing spotifyUserId')

        await this.createPlayer()
        const token = await this.ensureToken()

        // fetch user's top tracks directly using access token
        const topRes = await fetch('https://api.spotify.com/v1/me/top/tracks?limit=10', { headers: { Authorization: 'Bearer ' + token } })
        if (!topRes.ok) throw new Error(`Failed to fetch top tracks: ${await topRes.text()}`)
        const topJson = await topRes.json()
        const index = Math.max(0, Math.min(9, (this.playIndexDisplay || 1) - 1))
        const track = topJson.items && topJson.items[index]
        if (!track) throw new Error('No track at that index')

        if (!this.deviceId) {
          await new Promise(r => setTimeout(r, 700))
        }
        if (!this.deviceId) throw new Error('Web player device not ready')

        const playRes = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${this.deviceId}`, {
          method: 'PUT',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ uris: [track.uri] })
        })
        if (![200,202,204].includes(playRes.status)) {
          throw new Error(`Playback failed: ${await playRes.text()}`)
        }
        await this.fetchCurrentPlayback()
      } catch (err) {
        this.error = err.message
      }
    },
    async fetchCurrentPlayback() {
      try {
        const token = await this.ensureToken()
        const res = await fetch('https://api.spotify.com/v1/me/player', { headers: { Authorization: 'Bearer ' + token } })
        if (!res.ok) {
          this.isPlaying = false
          this.currentTrack = null
          return
        }
        const json = await res.json()
        if (!json || !json.item) {
          this.isPlaying = false
          this.currentTrack = null
          return
        }
        this.isPlaying = !!json.is_playing
        const t = json.item
        this.currentTrack = { name: t.name, artists: t.artists.map(a=>a.name).join(', '), album: t.album && t.album.name, image: t.album && t.album.images && t.album.images[0] && t.album.images[0].url }
      } catch (e) {
        this.isPlaying = false
        this.currentTrack = null
      }
    }
  }
}
</script>

<style>
input { padding: 6px; margin-right: 6px }
button { padding: 6px 10px }
</style>
