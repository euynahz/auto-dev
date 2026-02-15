import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout'
import { useWebSocket } from '@/hooks/useWebSocket'
import Dashboard from '@/pages/Dashboard'
import ProjectDetail from '@/pages/ProjectDetail'

function AppContent() {
  // Establish WebSocket connection
  useWebSocket()

  return (
    <AppLayout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/project/:id" element={<ProjectDetail />} />
      </Routes>
    </AppLayout>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  )
}
