import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import App from '../App.tsx'

describe('smoke', () => {
  it('renders the app shell', () => {
    render(<App />)
    expect(
      screen.getByRole('heading', { name: /payroll events/i }),
    ).toBeInTheDocument()
  })
})