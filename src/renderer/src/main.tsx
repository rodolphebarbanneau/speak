import { createRoot } from 'react-dom/client'
import '@fontsource-variable/jetbrains-mono'
import { App } from './app/app'
import { Overlay } from './overlay/overlay'
import { Preview } from './preview/preview'
import './styles.css'

const view = location.hash.slice(1) || 'main'
document.documentElement.dataset.view = view
document.documentElement.dataset.platform = window.speak.platform
document.title = view === 'preview' ? 'Speak — Preview' : view === 'overlay' ? 'Speak overlay' : 'Speak'

const root = createRoot(document.getElementById('root')!)
root.render(view === 'overlay' ? <Overlay /> : view === 'preview' ? <Preview /> : <App />)
