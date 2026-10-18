/* Shiny portal scene catalog; SPDX-License-Identifier: AGPL-3.0-or-later. */
export const NAMES = {
  shinyMark: 'Shiny',
  openaiMark: 'OpenAI / GPT',
  claudeMark: 'Claude',
  grokMark: 'Grok',
  glmMark: 'GLM',
  kimiMark: 'Kimi',
  deepseekMark: 'DeepSeek',
  qwenMark: 'Qwen',
  geminiMark: 'Gemini',
  mistralMark: 'Mistral',
  ollamaMark: 'Ollama',
  socket: '插接件',
  gyroscope: '陀螺仪',
  mobius: '莫比乌斯环',
  trefoil: '三叶结',
  helix: '螺旋',
  ribbon: '带状曲面',
  earth: '地球',
  moon: '月球',
  mars: '火星',
  sun: '太阳',
  solarSystem: '太阳系',
  galaxy: '星系',
  blackHole: '黑洞',
  pelicanBicycle: '鹈鹕骑车',
  spacexRocket: '火箭',
  rotatingChair: '旋转椅子',
  atomicExplosion: '原子爆炸',
  shop: '社区小店',
  vending: '自动售货机',
  stall: '集市摊位',
} satisfies Record<string, string>

export type SculptureId = keyof typeof NAMES
export const GROUPS: { id: string; label: string; scenes: SculptureId[] }[] = [
  { id: 'brand', label: 'Shiny', scenes: ['shinyMark'] },
  { id: 'models', label: '模型', scenes: ['openaiMark', 'claudeMark', 'grokMark', 'glmMark', 'kimiMark', 'deepseekMark', 'qwenMark', 'geminiMark', 'mistralMark', 'ollamaMark'] },
  { id: 'geometry', label: '几何', scenes: ['socket', 'gyroscope', 'mobius', 'trefoil', 'helix', 'ribbon'] },
  { id: 'cosmos', label: '宇宙', scenes: ['earth', 'moon', 'mars', 'sun', 'solarSystem', 'galaxy', 'blackHole'] },
  { id: 'playful', label: '趣味', scenes: ['pelicanBicycle', 'spacexRocket', 'rotatingChair', 'atomicExplosion'] },
  { id: 'store', label: '商店', scenes: ['shop', 'vending', 'stall'] },
]

export const FEATURED_SCENES: SculptureId[] = [
  'shinyMark', 'openaiMark', 'claudeMark', 'grokMark', 'gyroscope',
  'earth', 'galaxy', 'pelicanBicycle', 'shop', 'mobius',
]
