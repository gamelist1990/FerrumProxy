import React from 'react';
import './UI.css';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  fullWidth?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, className = '', fullWidth, ...props }, ref) => {
    return (
      <div className={`ui-input-group ${fullWidth ? 'w-full' : ''} ${className}`}>
        {label && <label className="ui-label">{label}</label>}
        <div className="ui-input-wrapper">
          <input ref={ref} className="ui-input" {...props} />
        </div>
      </div>
    );
  }
);
