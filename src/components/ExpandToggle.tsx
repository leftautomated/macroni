import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp } from "lucide-react";

interface ExpandToggleProps {
  isExpanded: boolean;
  onToggle: () => void;
}

export const ExpandToggle = ({ isExpanded, onToggle }: ExpandToggleProps) => {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      onClick={onToggle}
      title={isExpanded ? "Collapse" : "Expand"}
    >
      {isExpanded ? (
        <ChevronUp className="h-3.5 w-3.5" />
      ) : (
        <ChevronDown className="h-3.5 w-3.5" />
      )}
    </Button>
  );
};

