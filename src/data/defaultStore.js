import { LS_PLANS, LS_TRANSACTIONS, LS_USERS } from '../constants/storageKeys'
import { generateDemoTransactions } from './demoTransactions'

/** Stable primary keys so seed stays consistent across LS keys */
export const SEED_PLAN_DAILY = 'seed-plan-daily'
export const SEED_PLAN_MONTHLY = 'seed-plan-monthly'
export const SEED_PLAN_YEARLY = 'seed-plan-yearly'

export function defaultPlansList() {
  return [
    {
      id: SEED_PLAN_DAILY,
      name: 'Daily Pass',
      price: 2000,
      durationDays: 1,
      expiryType: 'duration',
      fixedExpiryTime: '23:59',
      isActive: true,
      createdAt: new Date(Date.now() - 864e5 * 30).toISOString(),
    },
    {
      id: SEED_PLAN_MONTHLY,
      name: 'Monthly Pro',
      price: 15000,
      durationDays: 30,
      expiryType: 'fixed',
      fixedExpiryTime: '21:00',
      isActive: true,
      createdAt: new Date(Date.now() - 864e5 * 60).toISOString(),
    },
    {
      id: SEED_PLAN_YEARLY,
      name: 'Yearly',
      price: 120000,
      durationDays: 365,
      expiryType: 'duration',
      fixedExpiryTime: '00:00',
      isActive: false,
      createdAt: new Date(Date.now() - 864e5 * 5).toISOString(),
    },
  ]
}

export function defaultUsersList() {
  return [
    {
      id: 'seed-user-1',
      phone: '+255712000001',
      device: 'SM-G998B / android-14',
      planId: SEED_PLAN_MONTHLY,
      planName: 'Monthly Pro',
      amount: 15000,
      startDate: new Date(Date.now() - 864e5 * 10).toISOString(),
      expiryDate: new Date(Date.now() + 864e5 * 20).toISOString(),
    },
    {
      id: 'seed-user-2',
      phone: '+255745111222',
      device: 'Pixel-8 / android-15',
      planId: SEED_PLAN_DAILY,
      planName: 'Daily Pass',
      amount: 2000,
      startDate: new Date(Date.now() - 864e5 * 1).toISOString(),
      expiryDate: new Date(Date.now() + 864e5 * 0.5).toISOString(),
    },
    {
      id: 'seed-user-3',
      phone: '+255622333444',
      device: 'TV-Box A12',
      planId: SEED_PLAN_DAILY,
      planName: 'Daily Pass',
      amount: 2000,
      startDate: new Date(Date.now() - 864e5 * 30).toISOString(),
      expiryDate: new Date(Date.now() - 864e5 * 1).toISOString(),
    },
  ]
}

export function defaultTransactionsList() {
  return generateDemoTransactions(26)
}

export function getDefaultForKey(key) {
  switch (key) {
    case LS_PLANS:
      return defaultPlansList()
    case LS_USERS:
      return defaultUsersList()
    case LS_TRANSACTIONS:
      return defaultTransactionsList()
    default:
      return []
  }
}
