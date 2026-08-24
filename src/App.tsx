import { Navigate, Routes, Route } from 'react-router'
import Home from './pages/Home'
import TranscriptStudio from './pages/TranscriptStudio'
import ClipPackage from './pages/ClipPackage'
import LegacyAssembleRedirect from './pages/LegacyAssembleRedirect'
import Diagnostics from './pages/Diagnostics'
import NewFindClipsJob from './pages/NewFindClipsJob'
import MobileApp from './mobile/MobileApp'

export default function App() {
  return (
    <Routes>
      <Route path="/m/*" element={<MobileApp />} />
      <Route path="/" element={<Home />} />
      <Route path="/new-job" element={<NewFindClipsJob />} />
      <Route path="/transcript-studio" element={<TranscriptStudio />} />
      <Route path="/clip-package" element={<ClipPackage />} />
      <Route path="/assemble" element={<LegacyAssembleRedirect />} />
      <Route path="/diagnostics" element={<Diagnostics />} />
      <Route path="/single-video" element={<Navigate to="/transcript-studio" replace />} />
      <Route path="/video" element={<Navigate to="/transcript-studio" replace />} />
      <Route path="/transcript" element={<Navigate to="/transcript-studio" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
