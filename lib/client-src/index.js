// bgjobs client —— bundle 入口（v0.1.61）：装配插件对象；被 esbuild 打包成
// window.__ModuleLoader__.load({ id:'bgjobs', factory }) 形态的单文件 lib/client.js。

const { apply } = require('./apply.js')

module.exports = { name: 'bgjobs-client', inject: ['slots'], apply }
