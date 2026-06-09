export const RESERVE_SCRIPT = `
  local spentKey = KEYS[1]
  local reservedKey = KEYS[2]
  local policyKey = KEYS[3]
  local reservationKey = KEYS[4]

  local cost = tonumber(ARGV[1])
  local ttl = tonumber(ARGV[2])

  local capMicro = tonumber(redis.call('HGET', policyKey, 'cap_micro') or '0') or 0
  local hardRaw = redis.call('HGET', policyKey, 'hard')
  local isHard = (hardRaw ~= '0' and hardRaw ~= 'false')

  if capMicro <= 0 then
    return {0, 'insufficient'}
  end

  local spent = tonumber(redis.call('GET', spentKey) or '0')
  local reserved = tonumber(redis.call('GET', reservedKey) or '0')

  if spent + reserved + cost > capMicro and isHard then
    return {0, 'insufficient'}
  end

  redis.call('INCRBY', reservedKey, cost)
  redis.call('SET', reservationKey, ARGV[1], 'EX', ttl)
  return {1, 'ok'}
`;

export const COMMIT_SCRIPT = `
  local spentKey = KEYS[1]
  local reservedKey = KEYS[2]
  local reservationKey = KEYS[3]
  local commitKey = KEYS[4]

  local actualMicro = tonumber(ARGV[1])
  local idempotencyTtl = tonumber(ARGV[2])

  if redis.call('EXISTS', commitKey) == 1 then
    return {0, 'already'}
  end

  local reservedMicro = redis.call('GET', reservationKey)
  if not reservedMicro then
    redis.call('SET', commitKey, ARGV[1], 'EX', idempotencyTtl)
    return {0, 'not_found'}
  end

  redis.call('INCRBY', spentKey, actualMicro)
  redis.call('DECRBY', reservedKey, tonumber(reservedMicro))
  redis.call('DEL', reservationKey)
  redis.call('SET', commitKey, ARGV[1], 'EX', idempotencyTtl)
  return {1, 'ok'}
`;

export const RELEASE_SCRIPT = `
  local reservedKey = KEYS[1]
  local reservationKey = KEYS[2]

  local reservedMicro = redis.call('GET', reservationKey)
  if not reservedMicro then
    return {1, 'ok'}
  end

  redis.call('DECRBY', reservedKey, tonumber(reservedMicro))
  redis.call('DEL', reservationKey)
  return {1, 'ok'}
`;
