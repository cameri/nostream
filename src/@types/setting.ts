export interface Setting {
  key: string,
  value: object,
  category: Category,
  createdAt: Date,
  updatedAt: Date,
}

enum Category {
  info = 'info',
  payments = 'payments',
  paymentsProcessors = 'paymentsProcessors',
  network = 'network',
  workers = 'workers',
  mirroring = 'mirroring',
  limits = 'limits',
    // invoice
    // connection
    // event
    // client
    // message
}

export interface DBSetting {
  key: string,
  value: object,
  category: Category,
  created_at: Date,
  updated_at: Date,
}
