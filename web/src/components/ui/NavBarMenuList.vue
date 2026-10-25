<script setup lang="ts">
import { computed } from 'vue'
import NavBarItem from '@/components/ui/NavBarItem.vue'
import { store as loginStore } from '!/auth/login'
import type { NavBarItem as NavBarItemType } from '@/menuNavBar'

const props = defineProps({
  menu: {
    type: Array<NavBarItemType>,
    default: () => []
  }
})

const login = loginStore()

const visibleMenu = computed(() =>
  props.menu.filter(
    (item) => !item.roles || item.roles.includes(login.authenticated?.user?.role ?? '')
  )
)

const emit = defineEmits(['menu-click'])

const menuClick = (event: Event, item: object) => {
  emit('menu-click', event, item)
}
</script>

<template>
  <NavBarItem
    v-for="(item, index) in visibleMenu"
    :key="index"
    :item="item"
    @menu-click="menuClick"
  />
</template>
