import React from 'react';
import './UI.css';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  icon?: React.ReactNode;
}

export const Button: React.FC<ButtonProps> = ({ 
  children, 
  variant = 'secondary', 
  className = '', 
  icon,
  ...props 
}) => {
  return (
    <button 
      className={`ui-button ui-button-${variant} ${className}`} 
      {...props}
    >
      {icon && <span className="ui-icon">{icon}</span>}
      {children}
    </button>
  );
};
