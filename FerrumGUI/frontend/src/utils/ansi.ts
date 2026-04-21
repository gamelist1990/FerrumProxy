// ANSI color codes to CSS color mapping

// Generated Gemini
const ANSI_COLORS: Record<string, string> = {
  '30': '#000000', // Black
  '31': '#e74856', // Red
  '32': '#16c60c', // Green
  '33': '#f9f1a5', // Yellow
  '34': '#3b78ff', // Blue
  '35': '#b4009e', // Magenta
  '36': '#61d6d6', // Cyan
  '37': '#cccccc', // White
  '90': '#767676', // Bright Black (Gray)
  '91': '#e74856', // Bright Red
  '92': '#16c60c', // Bright Green
  '93': '#f9f1a5', // Bright Yellow
  '94': '#3b78ff', // Bright Blue
  '95': '#b4009e', // Bright Magenta
  '96': '#61d6d6', // Bright Cyan
  '97': '#f2f2f2', // Bright White
};

const ANSI_BG_COLORS: Record<string, string> = {
  '40': '#000000',
  '41': '#e74856',
  '42': '#16c60c',
  '43': '#f9f1a5',
  '44': '#3b78ff',
  '45': '#b4009e',
  '46': '#61d6d6',
  '47': '#cccccc',
  '100': '#767676',
  '101': '#e74856',
  '102': '#16c60c',
  '103': '#f9f1a5',
  '104': '#3b78ff',
  '105': '#b4009e',
  '106': '#61d6d6',
  '107': '#f2f2f2',
};

// ESC character avoiding control-character literals in source
//こうしないと無効な制御文字とか言われる(´;ω;｀)
const ESC = String.fromCharCode(27);

interface AnsiStyle {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export function stripAnsi(text: string): string {
  // Remove ANSI escape codes
  return text.replace(new RegExp(ESC + '\\[[0-9;]*m', 'g'), '');
}

export function ansiToHtml(text: string): string {
  const parts: Array<{ text: string; style: AnsiStyle }> = [];
  let currentStyle: AnsiStyle = {};
  let currentText = '';

  // Replace ANSI escape sequences with HTML
  const regex = new RegExp(ESC + '\\[([0-9;]*)m', 'g');
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Add text before this escape code
    if (match.index > lastIndex) {
      currentText = text.substring(lastIndex, match.index);
      if (currentText) {
        parts.push({ text: currentText, style: { ...currentStyle } });
      }
    }

    // Parse escape code
    const codes = match[1].split(';').filter(c => c);
    for (const code of codes) {
      const num = parseInt(code);
      
      if (num === 0) {
        // Reset
        currentStyle = {};
      } else if (num === 1) {
        // Bold
        currentStyle.bold = true;
      } else if (num === 3) {
        // Italic
        currentStyle.italic = true;
      } else if (num === 4) {
        // Underline
        currentStyle.underline = true;
      } else if (ANSI_COLORS[code]) {
        // Foreground color
        currentStyle.color = ANSI_COLORS[code];
      } else if (ANSI_BG_COLORS[code]) {
        // Background color
        currentStyle.backgroundColor = ANSI_BG_COLORS[code];
      }
    }

    lastIndex = regex.lastIndex;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    currentText = text.substring(lastIndex);
    if (currentText) {
      parts.push({ text: currentText, style: { ...currentStyle } });
    }
  }

  // Convert to HTML
  return parts
    .map(({ text, style }) => {
      if (Object.keys(style).length === 0) {
        return escapeHtml(text);
      }

      const styles: string[] = [];
      if (style.color) styles.push(`color: ${style.color}`);
      if (style.backgroundColor) styles.push(`background-color: ${style.backgroundColor}`);
      if (style.bold) styles.push('font-weight: bold');
      if (style.italic) styles.push('font-style: italic');
      if (style.underline) styles.push('text-decoration: underline');

      return `<span style="${styles.join('; ')}">${escapeHtml(text)}</span>`;
    })
    .join('');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function formatLogMessage(message: string): string {
  // Remove box-drawing characters and replace with simple borders
  const formatted = message
    .replace(/[┌┐└┘├┤┬┴┼]/g, '+')
    .replace(/[─]/g, '-')
    .replace(/[│]/g, '|');
  
  return ansiToHtml(formatted);
}
