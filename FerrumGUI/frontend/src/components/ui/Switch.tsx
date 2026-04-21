import React from 'react';
import './UI.css';

interface SwitchProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
}

export const Switch: React.FC<SwitchProps> = ({ label, checked, onChange, className = '' }) => {
  return (
    <label className={`ui-switch ${className}`}>
      <input
        type="checkbox"
        className="ui-switch-input"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="ui-switch-track">
        <div className="ui-switch-thumb" />
      </div>
      <span className="ui-switch-label">{label}</span>
    </label>
  );
};
