<script setup lang="ts">
import { mdiClose } from '@mdi/js'
import { computed } from 'vue'
import { store as style } from '!/style'
import { store as crypto } from '!/crypto'
import AsideMenuList from '@/components/ui/AsideMenuList.vue'
import AsideFileTree from '@/components/ui/AsideFileTree.vue'
import FolderDropTarget from '@/components/files/FolderDropTarget.vue'
import BaseIcon from '@/components/ui/BaseIcon.vue'
import type { AsideMenuItemType } from '@/menuAside'
import StatsLi from '../files/StatsLi.vue'

defineProps<{
  menu: AsideMenuItemType[]
}>()

const cryptoStore = crypto()

const hasKeypair = computed(() => !!cryptoStore.keypair)

const emit = defineEmits(['menu-click', 'aside-lg-close-click'])
const styleStore = style()

const name = computed(() => import.meta.env.APP_NAME || 'Hoodik')
const version = computed(() => import.meta.env.APP_VERSION || '')

const menuClick = (event: Event, item: object) => {
  emit('menu-click', event, item)
}

const asideLgCloseClick = (event: Event) => {
  emit('aside-lg-close-click', event)
}
</script>

<template>
  <aside
    id="aside"
    class="lg:py-2 lg:pl-2 w-72 fixed flex z-40 top-0 h-screen transition-position overflow-hidden"
  >
    <div
      :class="styleStore.asideStyle"
      class="lg:rounded-2xl flex-1 flex flex-col overflow-hidden dark:bg-brownish-900"
    >
      <div
        :class="styleStore.asideBrandStyle"
        class="flex flex-row h-14 items-center justify-between dark:bg-brownish-900"
      >
        <div class="text-center flex-1 lg:text-left lg:pl-6 xl:text-center xl:pl-0">
          <b class="font-black">
            {{ name }} <span class="text-xs">{{ version }}</span>
          </b>
        </div>
        <button
          class="hidden lg:inline-block xl:hidden p-3"
          :title="$t('ui.aside.collapse')"
          :aria-label="$t('ui.aside.collapse')"
          @click.prevent="asideLgCloseClick"
        >
          <BaseIcon :path="mdiClose" />
        </button>
      </div>
      <div class="flex-1 overflow-y-auto overflow-x-hidden">
        <template v-for="item in menu" :key="(item.to as any)?.name || item.label">
          <template v-if="item.expandable && hasKeypair">
            <!-- The files entry stands for the account root: dropping dragged
                 rows on it moves them there. -->
            <FolderDropTarget
              :ancestors="[]"
              over-class="ring-2 ring-inset ring-orangy-400 bg-orangy-500/20"
            >
              <AsideMenuList :menu="[item]" @menu-click="menuClick" />
            </FolderDropTarget>
            <AsideFileTree :keypair="cryptoStore.keypair!" />
          </template>
          <AsideMenuList v-else :menu="[item]" @menu-click="menuClick" />
        </template>
      </div>

      <ul class="pt-3">
        <StatsLi />
      </ul>

      <div></div>
    </div>
  </aside>
</template>
