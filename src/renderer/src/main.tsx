import { createRoot } from 'react-dom/client'
import '@fontsource-variable/jetbrains-mono'
import { initThemes } from '@themes/index'
import { App } from './app/app'
import { Loader } from './loader/loader'
import { Overlay } from './overlay/overlay'
import { Preview } from './preview/preview'
import './styles.css'

const view = location.hash.slice(1) || 'main'
document.documentElement.dataset.view = view
document.documentElement.dataset.platform = window.speak.platform
document.title = view === 'preview' ? 'Speak — Preview' : view === 'overlay' ? 'Speak overlay' : 'Speak'
initThemes(view)

const root = createRoot(document.getElementById('root')!)
root.render(view === 'overlay' ? <Overlay /> : view === 'preview' ? <Preview /> : view === 'loader' ? <Loader /> : <App />)
