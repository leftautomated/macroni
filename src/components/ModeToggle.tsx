import { Moon, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useTheme } from "@/components/theme-provider"
import { useState } from "react"

export const ModeToggle = () => {
  const { setTheme } = useTheme()
  const [isOpen, setIsOpen] = useState(false)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button 
          variant="ghost" 
          size="icon" 
          className="h-8 w-8"
          onClick={() => setIsOpen(!isOpen)}
        >
          <Sun className="h-3.5 w-3.5 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
          <Moon className="absolute h-3.5 w-3.5 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
          <span className="sr-only">Toggle theme</span>
        </Button>
      </DropdownMenuTrigger>
      {isOpen && (
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => { setTheme("light"); setIsOpen(false); }}>
            Light
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => { setTheme("dark"); setIsOpen(false); }}>
            Dark
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => { setTheme("system"); setIsOpen(false); }}>
            System
          </DropdownMenuItem>
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  )
}

