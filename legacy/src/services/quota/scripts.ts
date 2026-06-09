export const CHECK_AND_RESERVE_SCRIPT = `
  local quotaKey = KEYS[1]
  local reservedKey = KEYS[2]
  local reservationKey = KEYS[3]
  local hashKey = KEYS[4]
  local cost = tonumber(ARGV[1])
  local reservationData = ARGV[2]
  local defaultBudget = tonumber(ARGV[3])
  local ttl = tonumber(ARGV[4])
  local reservationId = ARGV[5]

  local budget = tonumber(redis.call('hget', quotaKey, 'budget') or defaultBudget)
  local spent = tonumber(redis.call('hget', quotaKey, 'spent') or 0)
  local reserved = tonumber(redis.call('get', reservedKey) or 0)
  local hardLimit = redis.call('hget', quotaKey, 'hard_limit')
  local isHard = (hardLimit ~= '0' and hardLimit ~= 'false')

  if spent + reserved + cost > budget and isHard then
    return {0, 'insufficient_quota'}
  end

  redis.call('incrby', reservedKey, math.floor(cost))
  redis.call('set', reservationKey, reservationData, 'EX', ttl)
  redis.call('hset', hashKey, reservationId, reservationData)

  if spent + reserved + cost > budget then
    return {1, 'soft_overage'}
  end

  return {1, 'ok'}
`;

export const RELEASE_RESERVATION_SCRIPT = `
  local idempotencyKey = KEYS[1]
  local reservationKey = KEYS[2]
  local reservationId = ARGV[1]
  local idempotencyTtl = tonumber(ARGV[2])
  local reservedPrefix = ARGV[3]
  local hashPrefix = ARGV[4]

  if redis.call('exists', idempotencyKey) == 1 then
    return {0, 'already_released'}
  end

  local data = redis.call('get', reservationKey)
  if not data then
    redis.call('set', idempotencyKey, '0', 'EX', idempotencyTtl)
    return {0, 'not_found'}
  end

  local amountMicro, userId, month
  local idx = 0
  for part in string.gmatch(data, '[^|]+') do
    if idx == 0 then amountMicro = part
    elseif idx == 1 then userId = part
    elseif idx == 2 then month = part
    end
    idx = idx + 1
  end

  if not amountMicro or not userId or not month then
    redis.call('set', idempotencyKey, '0', 'EX', idempotencyTtl)
    return {0, 'parse_error'}
  end

  local reservedKey = reservedPrefix .. userId .. ':' .. month
  local hashKey = hashPrefix .. userId .. ':' .. month

  redis.call('incrby', reservedKey, -tonumber(amountMicro))
  redis.call('del', reservationKey)
  redis.call('hdel', hashKey, reservationId)
  redis.call('set', idempotencyKey, amountMicro, 'EX', idempotencyTtl)

  return {1, 'ok', amountMicro}
`;

export const RECONCILE_USAGE_SCRIPT = `
  local idempotencyKey = KEYS[1]
  local reservationKey = KEYS[2]
  local reservationId = ARGV[1]
  local costMicro = ARGV[2]
  local idempotencyTtl = tonumber(ARGV[3])
  local quotaPrefix = ARGV[4]
  local reservedPrefix = ARGV[5]
  local hashPrefix = ARGV[6]

  if redis.call('exists', idempotencyKey) == 1 then
    return {0, 'already_reconciled'}
  end

  local data = redis.call('get', reservationKey)
  if not data then
    redis.call('set', idempotencyKey, costMicro, 'EX', idempotencyTtl)
    return {0, 'not_found'}
  end

  local reservedAmountMicro, userId, month
  local idx = 0
  for part in string.gmatch(data, '[^|]+') do
    if idx == 0 then reservedAmountMicro = part
    elseif idx == 1 then userId = part
    elseif idx == 2 then month = part
    end
    idx = idx + 1
  end

  if not reservedAmountMicro or not userId or not month then
    redis.call('set', idempotencyKey, costMicro, 'EX', idempotencyTtl)
    return {0, 'parse_error'}
  end

  local quotaKey = quotaPrefix .. userId .. ':' .. month
  local reservedKey = reservedPrefix .. userId .. ':' .. month
  local hashKey = hashPrefix .. userId .. ':' .. month

  redis.call('hincrby', quotaKey, 'spent', tonumber(costMicro))
  redis.call('incrby', reservedKey, -tonumber(reservedAmountMicro))
  redis.call('del', reservationKey)
  redis.call('hdel', hashKey, reservationId)
  redis.call('set', idempotencyKey, costMicro, 'EX', idempotencyTtl)

  return {1, 'ok', costMicro, reservedAmountMicro}
`;

export const CLEANUP_ORPHAN_SCRIPT = `
  -- orphan_cleanup
  local hashKey = KEYS[1]
  local nowMs = tonumber(ARGV[1])
  local ttlMs = tonumber(ARGV[2])
  local idempotencyTtl = tonumber(ARGV[3])
  local reservationPrefix = ARGV[4]
  local reservedPrefix = ARGV[5]
  local idempotencyCleanupPrefix = ARGV[6]

  local fields = redis.call('hgetall', hashKey)
  local cleaned = 0

  for i = 1, #fields, 2 do
    local reservationId = fields[i]
    local data = fields[i + 1]

    local amountMicro, userId, month, createdAtStr
    local idx = 0
    for part in string.gmatch(data, '[^|]+') do
      if idx == 0 then amountMicro = part
      elseif idx == 1 then userId = part
      elseif idx == 2 then month = part
      elseif idx == 3 then createdAtStr = part
      end
      idx = idx + 1
    end

    if amountMicro and userId and month and createdAtStr then
      local createdAt = tonumber(createdAtStr)
      if createdAt and (nowMs - createdAt) > ttlMs then
        local reservationKey = reservationPrefix .. reservationId
        if redis.call('exists', reservationKey) == 0 then
          local idemKey = idempotencyCleanupPrefix .. reservationId
          if redis.call('exists', idemKey) == 0 then
            local reservedKey = reservedPrefix .. userId .. ':' .. month
            redis.call('incrby', reservedKey, -tonumber(amountMicro))
            redis.call('hdel', hashKey, reservationId)
            redis.call('set', idemKey, '1', 'EX', idempotencyTtl)
            cleaned = cleaned + 1
          end
        end
      end
    end
  end

  return cleaned
`;

export const TOP_UP_RESERVATION_SCRIPT = `
  local quotaKey = KEYS[1]
  local reservationKey = KEYS[2]
  local deltaMicro = tonumber(ARGV[1])
  local reservationId = ARGV[2]
  local defaultBudget = tonumber(ARGV[3])
  local ttl = tonumber(ARGV[4])
  local reservedPrefix = ARGV[5]
  local hashPrefix = ARGV[6]

  local data = redis.call('get', reservationKey)
  if not data then
    return {0, 'not_found'}
  end

  local amountMicroStr, userId, month, createdAt
  local idx = 0
  for part in string.gmatch(data, '[^|]+') do
    if idx == 0 then amountMicroStr = part
    elseif idx == 1 then userId = part
    elseif idx == 2 then month = part
    elseif idx == 3 then createdAt = part
    end
    idx = idx + 1
  end

  if not amountMicroStr or not userId or not month then
    return {0, 'parse_error'}
  end

  local amountMicro = tonumber(amountMicroStr)
  local newAmount = amountMicro + deltaMicro
  if newAmount < 0 then newAmount = 0 end

  local reservedKey = reservedPrefix .. userId .. ':' .. month
  local hashKey = hashPrefix .. userId .. ':' .. month

  if deltaMicro > 0 then
    local budget = tonumber(redis.call('hget', quotaKey, 'budget') or defaultBudget)
    local spent = tonumber(redis.call('hget', quotaKey, 'spent') or 0)
    local reserved = tonumber(redis.call('get', reservedKey) or 0)
    local hardLimit = redis.call('hget', quotaKey, 'hard_limit')
    local isHard = (hardLimit ~= '0' and hardLimit ~= 'false')

    if spent + reserved + deltaMicro > budget then
      if isHard then
        return {0, 'hard_rejected'}
      end
      redis.call('incrby', reservedKey, deltaMicro)
      local newData = newAmount .. '|' .. userId .. '|' .. month .. '|' .. (createdAt or '0')
      redis.call('set', reservationKey, newData, 'EX', ttl)
      redis.call('hset', hashKey, reservationId, newData)
      return {1, 'soft_overage'}
    end
  end

  redis.call('incrby', reservedKey, deltaMicro)
  local newData = newAmount .. '|' .. userId .. '|' .. month .. '|' .. (createdAt or '0')
  redis.call('set', reservationKey, newData, 'EX', ttl)
  redis.call('hset', hashKey, reservationId, newData)
  return {1, 'within_budget'}
`;
