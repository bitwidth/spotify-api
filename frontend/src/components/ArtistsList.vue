<template>
  <div>
    <h3>
      Followed artists
      <span style="font-weight:400;font-size:13px;color:#666">- showing {{ artists.length }}{{ total ? ' of ' + total : '' }}</span>
    </h3>
    <ul>
      <li v-for="a in artists" :key="a.id" style="margin-bottom:8px;display:flex;align-items:center">
        <img v-if="a.images && a.images[0]" :src="a.images[0].url" width="48" height="48" style="margin-right:8px" />
        <div>
          <div style="font-weight:600">{{ a.name }}</div>
          <div style="font-size:12px;color:#666">Followers: {{ a.followers.total }}</div>
        </div>
      </li>
    </ul>
  </div>
</template>

<script>
export default {
  props: ['artists', 'total']
}
</script>
