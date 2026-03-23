/**
 * Employee route tests
 *
 * Covers:
 *   GET    /api/merchants/:id/employees                  — list employees
 *   POST   /api/merchants/:id/employees                  — create employee
 *   PUT    /api/merchants/:id/employees/:empId           — update employee
 *   DELETE /api/merchants/:id/employees/:empId           — delete employee
 *   POST   /api/merchants/:id/employees/authenticate     — PIN auth + rate limit
 *   POST   /api/merchants/:id/employees/:empId/clock-in  — open shift
 *   POST   /api/merchants/:id/employees/:empId/clock-out — close shift
 *   GET    /api/merchants/:id/timesheets                  — timesheet list
 */

import { test, expect, beforeAll, describe } from 'bun:test'
import { app } from '../src/server'
import { getDatabase, closeDatabase } from '../src/db/connection'
import { migrate } from '../src/db/migrate'
import { initializeMasterKey } from '../src/crypto/master-key'
import { invalidateApplianceMerchantCache } from '../src/routes/store'

// ── fixtures ──────────────────────────────────────────────────────────────────

let ownerToken  = ''
let merchantId  = ''

// ── helpers ───────────────────────────────────────────────────────────────────

/** POST /employees */
async function createEmployee(body: Record<string, unknown>, token = ownerToken) {
  return app.fetch(new Request(
    `http://localhost:3000/api/merchants/${merchantId}/employees`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify(body),
    }
  ))
}

/** PUT /employees/:empId */
async function updateEmployee(empId: string, body: Record<string, unknown>, token = ownerToken) {
  return app.fetch(new Request(
    `http://localhost:3000/api/merchants/${merchantId}/employees/${empId}`,
    {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify(body),
    }
  ))
}

/** DELETE /employees/:empId */
async function deleteEmployee(empId: string, token = ownerToken) {
  return app.fetch(new Request(
    `http://localhost:3000/api/merchants/${merchantId}/employees/${empId}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
  ))
}

/** POST /employees/authenticate */
async function authenticatePin(code: string, token = ownerToken) {
  return app.fetch(new Request(
    `http://localhost:3000/api/merchants/${merchantId}/employees/authenticate`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ code }),
    }
  ))
}

/** POST /employees/:empId/clock-in */
async function clockIn(empId: string, token = ownerToken) {
  return app.fetch(new Request(
    `http://localhost:3000/api/merchants/${merchantId}/employees/${empId}/clock-in`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' }
  ))
}

/** POST /employees/:empId/clock-out */
async function clockOut(empId: string, body: Record<string, unknown> = {}, token = ownerToken) {
  return app.fetch(new Request(
    `http://localhost:3000/api/merchants/${merchantId}/employees/${empId}/clock-out`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify(body),
    }
  ))
}

// ── setup ──────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  closeDatabase()
  invalidateApplianceMerchantCache()
  process.env.DATABASE_PATH         = ':memory:'
  process.env.NODE_ENV              = 'test'
  process.env.MASTER_KEY_PASSPHRASE = 'TestPassword123!@#'
  process.env.JWT_SECRET            = 'test-jwt-secret-min-32-chars-long-for-testing-only'

  await migrate()
  await initializeMasterKey()

  const regRes = await app.fetch(new Request('http://localhost:3000/api/auth/register', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:        'owner@employees.test',
      password:     'SecurePass123!',
      fullName:     'Employees Owner',
      businessName: 'Employees Cafe',
      slug:         'employees-cafe',
    }),
  }))
  const regBody = await regRes.json() as { tokens: { accessToken: string }; merchant: { id: string } }
  ownerToken = regBody.tokens.accessToken
  merchantId = regBody.merchant.id
})

// ── POST /employees (create) ──────────────────────────────────────────────────

describe('POST /api/merchants/:id/employees', () => {
  test('creates a server employee and returns id + nickname + role', async () => {
    const res = await createEmployee({ nickname: 'Alice', accessCode: '1234', role: 'server' })
    expect(res.status).toBe(201)
    const body = await res.json() as { id: string; nickname: string; role: string }
    expect(body.id).toMatch(/^emp_/)
    expect(body.nickname).toBe('Alice')
    expect(body.role).toBe('server')
  })

  test('creates a manager employee', async () => {
    const res = await createEmployee({ nickname: 'Bob', accessCode: '5678', role: 'manager' })
    expect(res.status).toBe(201)
    const body = await res.json() as { role: string }
    expect(body.role).toBe('manager')
  })

  test('creates a chef employee', async () => {
    const res = await createEmployee({ nickname: 'Carol', accessCode: '9012', role: 'chef' })
    expect(res.status).toBe(201)
    const body = await res.json() as { role: string }
    expect(body.role).toBe('chef')
  })

  test('missing nickname returns 400', async () => {
    const res = await createEmployee({ accessCode: '1111', role: 'server' })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('nickname')
  })

  test('whitespace-only nickname returns 400', async () => {
    const res = await createEmployee({ nickname: '   ', accessCode: '2222', role: 'server' })
    expect(res.status).toBe(400)
  })

  test('nickname longer than 64 characters returns 400', async () => {
    const longName = 'A'.repeat(65)
    const res = await createEmployee({ nickname: longName, accessCode: '3333', role: 'server' })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('64')
  })

  test('nickname exactly 64 characters is accepted', async () => {
    const name64 = 'B'.repeat(64)
    const res = await createEmployee({ nickname: name64, accessCode: '4444', role: 'server' })
    expect(res.status).toBe(201)
  })

  test('accessCode not exactly 4 digits returns 400', async () => {
    const res = await createEmployee({ nickname: 'Dave', accessCode: '12', role: 'server' })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('4 digits')
  })

  test('non-numeric accessCode returns 400', async () => {
    const res = await createEmployee({ nickname: 'Eve', accessCode: 'abcd', role: 'server' })
    expect(res.status).toBe(400)
  })

  test('invalid role returns 400', async () => {
    const res = await createEmployee({ nickname: 'Frank', accessCode: '5555', role: 'owner' })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('role')
  })

  test('duplicate accessCode within same merchant returns 409', async () => {
    // 1234 already used by Alice above
    const res = await createEmployee({ nickname: 'George', accessCode: '1234', role: 'server' })
    expect(res.status).toBe(409)
  })

  test('unauthenticated request returns 401', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/employees`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ nickname: 'Ghost', accessCode: '6666', role: 'server' }),
      }
    ))
    expect(res.status).toBe(401)
  })
})

// ── GET /employees (list) ─────────────────────────────────────────────────────

describe('GET /api/merchants/:id/employees', () => {
  test('returns employee list with expected fields', async () => {
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/employees`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    ))
    expect(res.status).toBe(200)
    const body = await res.json() as { employees: unknown[] }
    expect(Array.isArray(body.employees)).toBe(true)
    expect(body.employees.length).toBeGreaterThan(0)
    const first = body.employees[0] as { id: string; nickname: string; role: string; active: boolean }
    expect(first.id).toBeDefined()
    expect(first.nickname).toBeDefined()
    expect(first.role).toBeDefined()
    expect(typeof first.active).toBe('boolean')
  })
})

// ── PUT /employees/:empId (update) ────────────────────────────────────────────

describe('PUT /api/merchants/:id/employees/:empId', () => {
  let empId = ''

  beforeAll(async () => {
    const res = await createEmployee({ nickname: 'UpdateMe', accessCode: '7777', role: 'server' })
    const body = await res.json() as { id: string }
    empId = body.id
  })

  test('updates nickname', async () => {
    const res = await updateEmployee(empId, { nickname: 'UpdatedName' })
    expect(res.status).toBe(200)
    const row = getDatabase()
      .query<{ nickname: string }, [string]>('SELECT nickname FROM employees WHERE id = ?')
      .get(empId)
    expect(row?.nickname).toBe('UpdatedName')
  })

  test('nickname update longer than 64 characters returns 400', async () => {
    const res = await updateEmployee(empId, { nickname: 'X'.repeat(65) })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('64')
  })

  test('whitespace-only nickname update returns 400', async () => {
    const res = await updateEmployee(empId, { nickname: '   ' })
    expect(res.status).toBe(400)
  })

  test('updates role', async () => {
    const res = await updateEmployee(empId, { role: 'chef' })
    expect(res.status).toBe(200)
    const row = getDatabase()
      .query<{ role: string }, [string]>('SELECT role FROM employees WHERE id = ?')
      .get(empId)
    expect(row?.role).toBe('chef')
  })

  test('invalid role in update returns 400', async () => {
    const res = await updateEmployee(empId, { role: 'superuser' })
    expect(res.status).toBe(400)
  })

  test('non-existent employee returns 404', async () => {
    const res = await updateEmployee('emp_doesnotexist', { nickname: 'Ghost' })
    expect(res.status).toBe(404)
  })

  test('deactivation sets active = false', async () => {
    const res = await updateEmployee(empId, { active: false })
    expect(res.status).toBe(200)
    const row = getDatabase()
      .query<{ active: number }, [string]>('SELECT active FROM employees WHERE id = ?')
      .get(empId)
    expect(row?.active).toBe(0)
  })
})

// ── DELETE /employees/:empId ──────────────────────────────────────────────────

describe('DELETE /api/merchants/:id/employees/:empId', () => {
  test('deletes employee and returns ok', async () => {
    const createRes = await createEmployee({ nickname: 'ToDelete', accessCode: '8888', role: 'server' })
    const { id } = await createRes.json() as { id: string }

    const delRes = await deleteEmployee(id)
    expect(delRes.status).toBe(200)
    const body = await delRes.json() as { ok: boolean }
    expect(body.ok).toBe(true)

    // Verify gone from DB
    const row = getDatabase()
      .query<{ id: string }, [string]>('SELECT id FROM employees WHERE id = ?')
      .get(id)
    expect(row).toBeNull()
  })

  test('non-existent employee returns 404', async () => {
    const res = await deleteEmployee('emp_doesnotexist')
    expect(res.status).toBe(404)
  })
})

// ── POST /employees/authenticate (PIN auth) ───────────────────────────────────

describe('POST /api/merchants/:id/employees/authenticate', () => {
  let pinEmpId = ''

  beforeAll(async () => {
    const res = await createEmployee({ nickname: 'PinEmployee', accessCode: '0001', role: 'server' })
    const body = await res.json() as { id: string }
    pinEmpId = body.id
  })

  test('valid PIN returns employee identity', async () => {
    const res = await authenticatePin('0001')
    expect(res.status).toBe(200)
    const body = await res.json() as {
      employee: { id: string; nickname: string; role: string }
      clockedIn: boolean
    }
    expect(body.employee.id).toBe(pinEmpId)
    expect(body.employee.nickname).toBe('PinEmployee')
    expect(body.employee.role).toBe('server')
    expect(typeof body.clockedIn).toBe('boolean')
  })

  test('wrong PIN returns 401', async () => {
    const res = await authenticatePin('9999')
    expect(res.status).toBe(401)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('Invalid')
  })

  test('non-4-digit code returns 400', async () => {
    const res = await authenticatePin('99')
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('Invalid code')
  })

  test('already-clocked-in employee has clockedIn=true', async () => {
    // Clock in first
    await clockIn(pinEmpId)

    const res = await authenticatePin('0001')
    expect(res.status).toBe(200)
    const body = await res.json() as { clockedIn: boolean; openShiftId: string | null }
    expect(body.clockedIn).toBe(true)
    expect(body.openShiftId).not.toBeNull()

    // Clock out to clean up
    await clockOut(pinEmpId)
  })
})

// ── clock-in / clock-out ──────────────────────────────────────────────────────

describe('POST clock-in and clock-out', () => {
  let shiftEmpId = ''

  beforeAll(async () => {
    const res = await createEmployee({ nickname: 'ShiftWorker', accessCode: '0002', role: 'server' })
    const body = await res.json() as { id: string }
    shiftEmpId = body.id
  })

  test('clock-in creates an open timesheet shift', async () => {
    const res = await clockIn(shiftEmpId)
    expect(res.status).toBe(201)
    const body = await res.json() as { shiftId: string; clockIn: string }
    expect(body.shiftId).toMatch(/^ts_/)
    expect(body.clockIn).toBeDefined()
  })

  test('second clock-in on same day returns 409', async () => {
    const res = await clockIn(shiftEmpId)
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('Already clocked in')
  })

  test('clock-out closes the open shift', async () => {
    const res = await clockOut(shiftEmpId)
    expect(res.status).toBe(200)
    const body = await res.json() as { shiftId: string; clockOut: string }
    expect(body.shiftId).toMatch(/^ts_/)
    expect(body.clockOut).toBeDefined()
  })

  test('clock-out with no open shift returns 404', async () => {
    // Already clocked out above
    const res = await clockOut(shiftEmpId)
    expect(res.status).toBe(404)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('No open shift')
  })

  test('clock-in for non-existent employee returns 404', async () => {
    const res = await clockIn('emp_doesnotexist')
    expect(res.status).toBe(404)
  })
})

// ── GET /timesheets ───────────────────────────────────────────────────────────

describe('GET /api/merchants/:id/timesheets', () => {
  test('returns timesheet list for date range', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/timesheets?from=${today}&to=${today}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    ))
    expect(res.status).toBe(200)
    const body = await res.json() as { timesheets: unknown[] }
    expect(Array.isArray(body.timesheets)).toBe(true)
  })

  test('unauthenticated request returns 401', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const res = await app.fetch(new Request(
      `http://localhost:3000/api/merchants/${merchantId}/timesheets?from=${today}&to=${today}`
    ))
    expect(res.status).toBe(401)
  })
})
