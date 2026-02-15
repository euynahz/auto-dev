import { Link, useLocation } from 'react-router-dom'
import { LayoutDashboard, Wifi, WifiOff, Sun, Moon } from 'lucide-react'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'
import { useEffect, useState } from 'react'

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  const toggle = () => {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('theme', next ? 'dark' : 'light')
  }
  useEffect(() => {
    const saved = localStorage.getItem('theme')
    if (saved === 'light') {
      setDark(false)
      document.documentElement.classList.remove('dark')
    }
  }, [])
  return { dark, toggle }
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const wsConnected = useStore((s) => s.wsConnected)
  const { dark, toggle } = useTheme()

  return (
    <div className="min-h-screen bg-background dot-grid-bg">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-background/80 backdrop-blur-xl">
        <div className="flex h-14 items-center px-6">
          <Link to="/" className="flex items-center gap-2.5 mr-8 group">
            <div className="relative">
              <img src="/logo.svg" alt="AutoDev" className="h-7 w-7 transition-transform duration-300 group-hover:scale-110" />
              <div className="absolute inset-0 bg-primary/20 rounded-full blur-md opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
            </div>
            <span className="font-bold text-lg gradient-text">AutoDev</span>
            <span className="text-[10px] text-muted-foreground bg-secondary/80 px-2 py-0.5 rounded-full font-medium tracking-wider uppercase">Agent</span>
          </Link>

          <nav className="flex items-center gap-1">
            <Link
              to="/"
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-all duration-200',
                location.pathname === '/'
                  ? 'bg-primary/10 text-primary shadow-sm shadow-primary/5'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
              )}
            >
              <LayoutDashboard className="h-4 w-4" />
              Dashboard
            </Link>
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <button
              onClick={toggle}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors cursor-pointer"
              title={dark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            >
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <div className="flex items-center gap-2 text-xs">
              {wsConnected ? (
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                  </span>
                  <Wifi className="h-3 w-3 text-emerald-400" />
                  <span className="text-emerald-400 font-medium">Connected</span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/10 border border-red-500/20">
                  <span className="relative flex h-2 w-2">
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                  </span>
                  <WifiOff className="h-3 w-3 text-red-400" />
                  <span className="text-red-400 font-medium">Disconnected</span>
                </div>
              )}
            </div>
          </div>
        </div>
        {/* Animated gradient line */}
        <div className="gradient-line" />
      </header>

      {/* Main content */}
      <main className="p-6">{children}</main>
    </div>
  )
}
