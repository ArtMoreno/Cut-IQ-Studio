import { Navigate, Routes, Route } from 'react-router'
import Home from './pages/Home'
import TranscriptStudio from './pages/TranscriptStudio'
import ClipPackage from './pages/ClipPackage'
import LegacyAssembleRedirect from './pages/LegacyAssembleRedirect'
import Diagnostics from './pages/Diagnostics'
import { HowItWorks } from './pages/HowItWorks'
import NewFindClipsJob from './pages/NewFindClipsJob'
import MobileApp from './mobile/MobileApp'
import { ProDialog } from './components/ProDialog'

export default function App() {
  return (
    <>
      {/* Mounted above the routes so any gated control can open it. */}
      <ProDialog />
      <Routes>
      <Route path="/m/*" element={<MobileApp />} />
      <Route path="/" element={<Home />} />
      <Route path="/new-job" element={<NewFindClipsJob />} />
      <Route path="/transcript-studio" element={<TranscriptStudio />} />
      <Route path="/clip-package" element={<ClipPackage />} />
      <Route path="/assemble" element={<LegacyAssembleRedirect />} />
      <Route path="/how-it-works" element={<HowItWorks />} />
      <Route path="/diagnostics" element={<Diagnostics />} />
      <Route path="/single-video" element={<Navigate to="/transcript-studio" replace />} />
      <Route path="/video" element={<Navigate to="/transcript-studio" replace />} />
      <Route path="/transcript" element={<Navigate to="/transcript-studio" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}
