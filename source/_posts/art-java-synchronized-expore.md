---
title: synchronized实现原理探究
date: 2022-07-30 00:22:28
tags:
- Java
- Android
- ART
- Thread
- Synchronized
categories: 
- Android
---
最近学习Android开发，了解到Java中可以使用synchronized块进行线程同步。
因此来探究一下在Android中，synchronized是怎么实现的。

<!-- more -->

## 简单Demo

### 示例代码

使用到synchronized块的示例代码如下：
```java
public class ThreadUtils {
    private int mVal;

    public void testSync() {
        synchronized (this) {
            mVal = 100;
        }
    }
}
```

上面的Java代码编译后的Dex字节码如下：

### 字节码

```
# virtual methods
.method public testSync()V
    .registers 2

    .line 7
    // 进入synchronized块
    monitor-enter p0

    .line 8
    // 给v0 寄存器赋值 0x64 也就是十进制的100
    const/16 v0, 0x64

    :try_start_3
    // p0寄存器是当前对象
    // 将v0中的值移动到p0寄存器中对象的mVal属性中
    iput v0, p0, Lcom/example/application01/ThreadUtils;->mVal:I

    .line 9
    // 退出synchronized块
    monitor-exit p0

    .line 10
    return-void

    .line 9
    :catchall_7
    move-exception v0

    // 退出synchronized块
    monitor-exit p0
    :try_end_9
    .catchall {:try_start_3 .. :try_end_9} :catchall_7

    throw v0
.end method
```
可以看到：

1. 在进入synchronized块的时候会自动生成一条monitor-enter p0指令
2. 退出synchronized块的时候会自动生成一条monitor-exit p0指令

因此可以看一下ART虚拟机在执行monitor-enter/monitor-exit指令时做了哪些事情来探究一下synchronized块的实现原理。

## ART源码分析

### MonitorEnter 加锁

当ART执行monitor-enter指令时，其最终会调用到Monitor::MonitorEnter函数。

#### Monitor::MonitorEnter

```c++
while (true) {
    //获取LockWord
    LockWord lock_word = h_obj->GetLockWord(false);
    switch (lock_word.GetState()) {
      case LockWord::kUnlocked: {
        // 如果是未加锁状态，则直接获取锁
        // No ordering required for preceding lockword read, since we retest.
        LockWord thin_locked(LockWord::FromThinLockId(thread_id, 0, lock_word.GCState()));
        // 方法内部获取到Object内部的monitor变量
        // monitor实际上是一个AtomicInteger* (aka Atomic<uint_32>)
        // 然后调用std::atomic::compare_exchange_strong进行变量读写
        if (h_obj->CasLockWord(lock_word, thin_locked, CASMode::kWeak, std::memory_order_acquire)) {
        // 写成功，说明已经拿到锁，直接返回
          AtraceMonitorLock(self, h_obj.Get(), /* is_wait= */ false);
          return h_obj.Get();  // Success!
        }
        // 未成功，再次尝试获取锁
        continue;  // Go again.
      }
      // 已经是锁定状态
      case LockWord::kThinLocked: {
        uint32_t owner_thread_id = lock_word.ThinLockOwner();
        // 如果是当前线程拥有锁
        if (owner_thread_id == thread_id) {
          // No ordering required for initial lockword read.
          // We own the lock, increase the recursion count.
          uint32_t new_count = lock_word.ThinLockCount() + 1;
          // 这里进行判断，如果未超过ThinLock的最大值，则不进行锁膨胀
          // 如果已经超过最大值，进行锁膨胀
          if (LIKELY(new_count <= LockWord::kThinLockMaxCount)) {
            LockWord thin_locked(LockWord::FromThinLockId(thread_id,
                                                          new_count,
                                                          lock_word.GCState()));
            // Only this thread pays attention to the count. Thus there is no need for stronger
            // than relaxed memory ordering.
            if (!kUseReadBarrier) {
              h_obj->SetLockWord(thin_locked, /* as_volatile= */ false);
              AtraceMonitorLock(self, h_obj.Get(), /* is_wait= */ false);
              return h_obj.Get();  // Success!
            } else {
              // Use CAS to preserve the read barrier state.
              if (h_obj->CasLockWord(lock_word,
                                     thin_locked,
                                     CASMode::kWeak,
                                     std::memory_order_relaxed)) {
                AtraceMonitorLock(self, h_obj.Get(), /* is_wait= */ false);
                return h_obj.Get();  // Success!
              }
            }
            continue;  // Go again.
          } else {
            // We'd overflow the recursion count, so inflate the monitor.
            // 超过自旋次数，说明当前线程难以拿到锁，进行锁膨胀
            InflateThinLocked(self, h_obj, lock_word, 0);
          }
        } else {
          if (trylock) {
            return nullptr;
          }
          // Contention.
          contention_count++;
          Runtime* runtime = Runtime::Current();
          // 判断是否超过最大自旋次数
          if (contention_count
              <= kExtraSpinIters + runtime->GetMaxSpinsBeforeThinLockInflation()) {
            // TODO: Consider switching the thread state to kWaitingForLockInflation when we are
            // yielding.  Use sched_yield instead of NanoSleep since NanoSleep can wait much longer
            // than the parameter you pass in. This can cause thread suspension to take excessively
            // long and make long pauses. See b/16307460.
            if (contention_count > kExtraSpinIters) {
            // 尝试简单休眠一下线程，然后再次唤醒进行锁竞争
            // PS: 这是一个System Call，让线程让出CPU，并将线程放到线程调度队列最后
              sched_yield();
            }
          } else {
          // 如果超过最大自旋次数，进行锁膨胀
            contention_count = 0;
            // No ordering required for initial lockword read. Install rereads it anyway.
            InflateThinLocked(self, h_obj, lock_word, 0);
          }
        }
        continue;  // Start from the beginning.
      }
      case LockWord::kFatLocked: {
        // We should have done an acquire read of the lockword initially, to ensure
        // visibility of the monitor data structure. Use an explicit fence instead.
        // 已经是完成了锁膨胀的状态，LockWord已经变成FatWord，LockWorkd的后28bit是MonitorId
        std::atomic_thread_fence(std::memory_order_acquire);
        Monitor* mon = lock_word.FatLockMonitor();
        if (trylock) {
          return mon->TryLock(self) ? h_obj.Get() : nullptr;
        } else {
          mon->Lock(self);
          DCHECK(mon->monitor_lock_.IsExclusiveHeld(self));
          return h_obj.Get();  // Success!
        }
      }
      case LockWord::kHashCode:
        // Inflate with the existing hashcode.
        // Again no ordering required for initial lockword read, since we don't rely
        // on the visibility of any prior computation.
        Inflate(self, nullptr, h_obj.Get(), lock_word.GetHashCode());
        continue;  // Start from the beginning.
      default: {
        LOG(FATAL) << "Invalid monitor state " << lock_word.GetState();
        UNREACHABLE();
      }
}
```
#### Monitor::InflateThinLocked

```c++
void Monitor::InflateThinLocked(Thread* self, Handle<mirror::Object> obj, LockWord lock_word,
                                uint32_t hash_code) {
  DCHECK_EQ(lock_word.GetState(), LockWord::kThinLocked);
  uint32_t owner_thread_id = lock_word.ThinLockOwner();
  if (owner_thread_id == self->GetThreadId()) {
    // We own the monitor, we can easily inflate it.
    // 如果是当前线程，直接进行锁膨胀
    Inflate(self, self, obj.Get(), hash_code);
  } else {
    ThreadList* thread_list = Runtime::Current()->GetThreadList();
    // Suspend the owner, inflate. First change to blocked and give up mutator_lock_.
    // 给当前线程的tlsPtr_设置monitor_enter_object
    self->SetMonitorEnterObject(obj.Get());
    bool timed_out;
    Thread* owner;
    {
      // 自动将当前线程从runable状态切换到suspended状态
      ScopedThreadSuspension sts(self, ThreadState::kWaitingForLockInflation);
      // 挂起owner线程
      owner = thread_list->SuspendThreadByThreadId(owner_thread_id,
                                                   SuspendReason::kInternal,
                                                   &timed_out);
      // 此处将当前线程从suspended状态切换回runable
    }
    if (owner != nullptr) {
      // We succeeded in suspending the thread, check the lock's status didn't change.
      lock_word = obj->GetLockWord(true);
      if (lock_word.GetState() == LockWord::kThinLocked &&
          lock_word.ThinLockOwner() == owner_thread_id) {
        // Go ahead and inflate the lock.
        // 真正在这里执行锁膨胀
        Inflate(self, owner, obj.Get(), hash_code);
      }
      // 恢复线程执行
      bool resumed = thread_list->Resume(owner, SuspendReason::kInternal);
      DCHECK(resumed);
    }
    self->SetMonitorEnterObject(nullptr);
  }
}
```

#### Monitor::Inflate

```c++
void Monitor::Inflate(Thread* self, Thread* owner, ObjPtr<mirror::Object> obj, int32_t hash_code) {
  DCHECK(self != nullptr);
  DCHECK(obj != nullptr);
  // Allocate and acquire a new monitor.
  // 在MonitorPool中创建Monitor
  Monitor* m = MonitorPool::CreateMonitor(self, owner, obj, hash_code);
  DCHECK(m != nullptr);
  // 在这里面把thinLockWork变成fatLockWord
  if (m->Install(self)) {
    if (owner != nullptr) {
      VLOG(monitor) << "monitor: thread" << owner->GetThreadId()
          << " created monitor " << m << " for object " << obj;
    } else {
      VLOG(monitor) << "monitor: Inflate with hashcode " << hash_code
          << " created monitor " << m << " for object " << obj;
    }
    Runtime::Current()->GetMonitorList()->Add(m);
    CHECK_EQ(obj->GetLockWord(true).GetState(), LockWord::kFatLocked);
  } else {
    MonitorPool::ReleaseMonitor(self, m);
  }
}
```

#### Monitor::Lock

```c++
void Monitor::Lock(Thread* self) {
  bool called_monitors_callback = false;
  // 尝试spin+cas方式获取futex锁几次，如果能成功获取到，说明竞争不多，可以直接锁定
  // 涉及futex机制
  if (TryLock(self, /*spin=*/ true)) {
    // TODO: This preserves original behavior. Correct?
    if (called_monitors_callback) {
      CHECK(reason == LockReason::kForLock);
      Runtime::Current()->GetRuntimeCallbacks()->MonitorContendedLocked(this);
    }
    return;
  }
  // Contended; not reentrant. We hold no locks, so tread carefully.
  const bool log_contention = (lock_profiling_threshold_ != 0);
  uint64_t wait_start_ms = log_contention ? MilliTime() : 0;

  Thread *orig_owner = nullptr;
  ArtMethod* owners_method;
  uint32_t owners_dex_pc;

  // Do this before releasing the mutator lock so that we don't get deflated.
  size_t num_waiters = num_waiters_.fetch_add(1, std::memory_order_relaxed);

  bool started_trace = false;
  //..... 中间忽略很多代码
  // Call the contended locking cb once and only once. Also only call it if we are locking for
  // the first time, not during a Wait wakeup.
  if (reason == LockReason::kForLock && !called_monitors_callback) {
    called_monitors_callback = true;
    Runtime::Current()->GetRuntimeCallbacks()->MonitorContendedLocking(this);
  }
  self->SetMonitorEnterObject(GetObject().Ptr());
  {
    // Change to blocked and give up mutator_lock_.
    ScopedThreadSuspension tsc(self, ThreadState::kBlocked);

    // Acquire monitor_lock_ without mutator_lock_, expecting to block this time.
    // We already tried spinning above. The shutdown procedure currently assumes we stop
    // touching monitors shortly after we suspend, so don't spin again here.
    monitor_lock_.ExclusiveLock(self);
    // ......
  }
  // We've successfully acquired monitor_lock_, released thread_list_lock, and are runnable.

  // We avoided touching monitor fields while suspended, so set owner_ here.
  owner_.store(self, std::memory_order_relaxed);
  DCHECK_EQ(lock_count_, 0u);
  
  self->SetMonitorEnterObject(nullptr);
  num_waiters_.fetch_sub(1, std::memory_order_relaxed);
  DCHECK(monitor_lock_.IsExclusiveHeld(self));
  // We need to pair this with a single contended locking call. NB we match the RI behavior and call
  // this even if MonitorEnter failed.
  if (called_monitors_callback) {
    CHECK(reason == LockReason::kForLock);
    Runtime::Current()->GetRuntimeCallbacks()->MonitorContendedLocked(this);
  }
}
```

#### Monitor::TryLock

```c++
bool Monitor::TryLock(Thread* self, bool spin) {
  Thread *owner = owner_.load(std::memory_order_relaxed);
  if (owner == self) {
    // 如果当前线程是monitor的owner，直接返回就好，不需要再尝试获取锁
    lock_count_++;
  } else {
    // 根据是否spin尝试不同的获取锁的方式
    bool success = spin ? monitor_lock_.ExclusiveTryLockWithSpinning(self)
        : monitor_lock_.ExclusiveTryLock(self);
    if (!success) {
      return false;
    }
    // 更新owner
    owner_.store(self, std::memory_order_relaxed);
    // ....
  }
  // ....
  return true;
}
```

#### Mutex::ExclusiveTryLock

```c++
bool Mutex::ExclusiveTryLock(Thread* self) {
   // ....
  if (!recursive_ || !IsExclusiveHeld(self)) {
#if ART_USE_FUTEXES
    bool done = false;
    do {
      int32_t cur_state = state_and_contenders_.load(std::memory_order_relaxed);
      if ((cur_state & kHeldMask) == 0) {
        // 没有人持有锁，这里竞争者应该会比较少，尝试使用CAS方式获取锁，效率会比较高
        // Change state to held and impose load/store ordering appropriate for lock acquisition.
        done = state_and_contenders_.CompareAndSetWeakAcquire(cur_state, cur_state | kHeldMask);
      } else {
        // 已经有人获取了锁，直接返回好了
        return false;
      }
    } while (!done);
    // ...
#else
    int result = pthread_mutex_trylock(&mutex_);
    if (result == EBUSY) {
      return false;
    }
    if (result != 0) {
      errno = result;
      PLOG(FATAL) << "pthread_mutex_trylock failed for " << name_;
    }
#endif
    //... 
    exclusive_owner_.store(SafeGetTid(self), std::memory_order_relaxed);
    RegisterAsLocked(self);
  }
  // ....
  return true;
}
```

#### Mutex::ExclusiveTryLockWithSpinning

```c++
bool Mutex::ExclusiveTryLockWithSpinning(Thread* self) {
  // Spin a small number of times, since this affects our ability to respond to suspension
  // requests. We spin repeatedly only if the mutex repeatedly becomes available and unavailable
  // in rapid succession, and then we will typically not spin for the maximal period.
  const int kMaxSpins = 5;
  for (int i = 0; i < kMaxSpins; ++i) {
    if (ExclusiveTryLock(self)) {
      return true;
    }
#if ART_USE_FUTEXES
    // WaitBrieflyFor内部会进行自旋，如果这里自旋依然无法持有锁，说明竞争条件比较多
    // 没必要继续自旋下去，直接尝试后面的futex系统调用，休眠线程
    if (!WaitBrieflyFor(&state_and_contenders_, self,
            [](int32_t v) { return (v & kHeldMask) == 0; })) {
      return false;
    }
#endif
  }
  return ExclusiveTryLock(self);
}
```

#### Mutex::ExclusiveLock

```c++
void Mutex::ExclusiveLock(Thread* self) {
  if (!recursive_ || !IsExclusiveHeld(self)) {
#if ART_USE_FUTEXES
    bool done = false;
    do {
      int32_t cur_state = state_and_contenders_.load(std::memory_order_relaxed);
          // 说明没有人持有锁，尝试CAS方式获取，如果获取到，直接返回
      if (LIKELY((cur_state & kHeldMask) == 0) /* lock not held */) {
        done = state_and_contenders_.CompareAndSetWeakAcquire(cur_state, cur_state | kHeldMask);
      } else {
        // Failed to acquire, hang up.
        ScopedContentionRecorder scr(this, SafeGetTid(self), GetExclusiveOwnerTid());
        // Empirically, it appears important to spin again each time through the loop; if we
        // bother to go to sleep and wake up, we should be fairly persistent in trying for the
        // lock.
        if (!WaitBrieflyFor(&state_and_contenders_, self,
                            [](int32_t v) { return (v & kHeldMask) == 0; })) {
                  // 进入到这里面说明是自选了一段时间以后依然没有得到锁
          // Increment contender count. We can not create enough threads for this to overflow.
                  // 原子性的state_and_contenders_ + 1
          increment_contenders();
          // Make cur_state again reflect the expected value of state_and_contenders.
          cur_state += kContenderIncrement;
          if (UNLIKELY(should_respond_to_empty_checkpoint_request_)) {
            self->CheckEmptyCheckpointFromMutex();
          }

          uint64_t wait_start_ms = enable_monitor_timeout_ ? MilliTime() : 0;
          uint64_t try_times = 0;
          do {
            timespec timeout_ts;
            timeout_ts.tv_sec = 0;
            timeout_ts.tv_nsec = Runtime::Current()->GetMonitorTimeoutNs();
                        // 这里的逻辑是，如果state_and_contenders_跟cur_state相等，则挂起线程，直到有其他线程wakeup或超时
                        // 根据上面的逻辑，如果有人持有锁，才会走到这里，因此cur_state的held_mask标记位是有人持有锁，所以state_and_contenders_跟cur_state相等
                        // 表示现在是有人再持有锁的
            if (futex(state_and_contenders_.Address(), FUTEX_WAIT_PRIVATE, cur_state,
                      enable_monitor_timeout_ ? &timeout_ts : nullptr , nullptr, 0) != 0) {
              // We only went to sleep after incrementing and contenders and checking that the
              // lock is still held by someone else.  EAGAIN and EINTR both indicate a spurious
              // failure, try again from the beginning.  We do not use TEMP_FAILURE_RETRY so we can
              // intentionally retry to acquire the lock.
                          // ........
            }
            SleepIfRuntimeDeleted(self);
            // Retry until not held. In heavy contention situations we otherwise get redundant
            // futex wakeups as a result of repeatedly decrementing and incrementing contenders.
            cur_state = state_and_contenders_.load(std::memory_order_relaxed);
          } while ((cur_state & kHeldMask) != 0);
          decrement_contenders();
        }
      }
    } while (!done);
    // Confirm that lock is now held.
    DCHECK_NE(state_and_contenders_.load(std::memory_order_relaxed) & kHeldMask, 0);
#else
        // 如果不支持futex，这里使用pthread_mutex进行实现，不做具体分析了
    CHECK_MUTEX_CALL(pthread_mutex_lock, (&mutex_));
#endif
        // .....
    exclusive_owner_.store(SafeGetTid(self), std::memory_order_relaxed);
    RegisterAsLocked(self);
        // ......
  }
  recursion_count_++;
}
```

### MonitorExit 释放锁

ART虚拟机在执行到monitor-exit的时候，最终会执行到Monitor::MonitorExit函数。

#### Monitor::MonitorExit

```c++
bool Monitor::MonitorExit(Thread* self, ObjPtr<mirror::Object> obj) {
  // ...
  StackHandleScope<1> hs(self);
  Handle<mirror::Object> h_obj(hs.NewHandle(obj));
  while (true) {
    LockWord lock_word = obj->GetLockWord(true);
    switch (lock_word.GetState()) {
      case LockWord::kHashCode:
        // Fall-through.
      case LockWord::kUnlocked:
        // 在这里面抛出异常
        FailedUnlock(h_obj.Get(), self->GetThreadId(), 0u, nullptr);
        return false;  // Failure.
      case LockWord::kThinLocked: {
        uint32_t thread_id = self->GetThreadId();
        uint32_t owner_thread_id = lock_word.ThinLockOwner();
        if (owner_thread_id != thread_id) {
          // 抛出异常
          FailedUnlock(h_obj.Get(), thread_id, owner_thread_id, nullptr);
          return false;  // Failure.
        } else {
          // We own the lock, decrease the recursion count.
          // 如果LockWord中的recusion count 不为0，递减
          // 如果已经是0， 直接重置LockWord，变为无锁状态的
          LockWord new_lw = LockWord::Default();
          if (lock_word.ThinLockCount() != 0) {
            uint32_t new_count = lock_word.ThinLockCount() - 1;
            new_lw = LockWord::FromThinLockId(thread_id, new_count, lock_word.GCState());
          } else {
            new_lw = LockWord::FromDefault(lock_word.GCState());
          }
          if (!kUseReadBarrier) {
            // ....
            // TODO: This really only needs memory_order_release, but we currently have
            // no way to specify that. In fact there seem to be no legitimate uses of SetLockWord
            // with a final argument of true. This slows down x86 and ARMv7, but probably not v8.
            h_obj->SetLockWord(new_lw, true);
            AtraceMonitorUnlock();
            // Success!
            return true;
          } else {
            // Use CAS to preserve the read barrier state.
            if (h_obj->CasLockWord(lock_word, new_lw, CASMode::kWeak, std::memory_order_release)) {
              AtraceMonitorUnlock();
              // Success!
              return true;
            }
          }
          continue;  // Go again.
        }
      }
      case LockWord::kFatLocked: {
        // 已经是Fat LockWord，走Monitor的unlock逻辑，见2.2.2
        Monitor* mon = lock_word.FatLockMonitor();
        return mon->Unlock(self);
      }
      default: {
        // ...
      }
    }
  }
}
```

#### Monitor::Unlock

```c++
bool Monitor::Unlock(Thread* self) {
  // ...
  Thread* owner = owner_.load(std::memory_order_relaxed);
  if (owner == self) {
    // We own the monitor, so nobody else can be in here.
    CheckLockOwnerRequest(self);
    AtraceMonitorUnlock();
    if (lock_count_ == 0) {
      owner_.store(nullptr, std::memory_order_relaxed);
      // 解锁并唤醒其他调用了Object.wait()正在等待的线程，见2.2.3
      SignalWaiterAndReleaseMonitorLock(self);
    } else {
      --lock_count_;
      //...
      // Keep monitor_lock_, but pretend we released it.
      FakeUnlockMonitorLock();
    }
    return true;
  }
  
  // 下面是解锁失败，抛出异常
  // ...
  return false;
}
```

#### Monitor::SignalWaiterAndReleaseMonitorLock

```c++
void Monitor::SignalWaiterAndReleaseMonitorLock(Thread* self) {
  // We want to release the monitor and signal up to one thread that was waiting
  // but has since been notified.
  // ...
  while (wake_set_ != nullptr) {
    // No risk of waking ourselves here; since monitor_lock_ is not released until we're ready to
    // return, notify can't move the current thread from wait_set_ to wake_set_ until this
    // method is done checking wake_set_.
    // 获取wake_set_中第一个元素
    // wake_set_在Object.notify()或Object.notifyAll()中被设置
    Thread* thread = wake_set_;
    wake_set_ = thread->GetWaitNext();
    thread->SetWaitNext(nullptr);
    // ...
    // Check to see if the thread is still waiting.
    {
      MutexLock wait_mu(self, *thread->GetWaitMutex());
      // wait_monitor_在Object.wait()时候被设置
      if (thread->GetWaitMonitor() != nullptr) {
        // 此时说明该线程依然在等待，当前线程释放锁并唤醒对应线程
        // Release the lock, so that a potentially awakened thread will not
        // immediately contend on it. The lock ordering here is:
        // monitor_lock_, self->GetWaitMutex, thread->GetWaitMutex
        // 释放锁，见2.2.4
        monitor_lock_.Unlock(self);  // Releases contenders.
        // 在这里唤醒正在等待中的线程
        // 这里执行完毕后，被唤醒的线程会重新尝试调用Monitor::Lock()获取锁
        // 见2.3.5
        thread->GetWaitConditionVariable()->Signal(self);
        return;
      }
    }
  }
  monitor_lock_.Unlock(self);
  DCHECK(!monitor_lock_.IsExclusiveHeld(self));
}
```

#### Mutex::Unlock

```c++
void Unlock(Thread* self) RELEASE() {  ExclusiveUnlock(self); }

void Mutex::ExclusiveUnlock(Thread* self) {
  // ...
  recursion_count_--;
  if (!recursive_ || recursion_count_ == 0) {
    // ...
    RegisterAsUnlocked(self);
#if ART_USE_FUTEXES
    bool done = false;
    do {
      int32_t cur_state = state_and_contenders_.load(std::memory_order_relaxed);
      if (LIKELY((cur_state & kHeldMask) != 0)) {
        // We're no longer the owner.
        exclusive_owner_.store(0 /* pid */, std::memory_order_relaxed);
        // Change state to not held and impose load/store ordering appropriate for lock release.
        // 重新设置state，标记为无持有者
        uint32_t new_state = cur_state & ~kHeldMask;  // Same number of contenders.
        // CAS方式设置state
        done = state_and_contenders_.CompareAndSetWeakRelease(cur_state, new_state);
        if (LIKELY(done)) {  // Spurious fail or waiters changed ?
          if (UNLIKELY(new_state != 0) /* have contenders */) {
            // 依然存在竞争线程
            // 唤醒kWakeOne个在state_and_contenders_.Address()上等待的线程
            futex(state_and_contenders_.Address(), FUTEX_WAKE_PRIVATE, kWakeOne,
                  nullptr, nullptr, 0);
          } 
          // 没有走进上面的if说明当前锁没有竞争线程，
          // CAS方式更改state_and_contenders_计数器已经足够，不需要唤醒其他线程
        }
      } else {
        // ...
      }
    } while (!done);
#else
    exclusive_owner_.store(0 /* pid */, std::memory_order_relaxed);
    CHECK_MUTEX_CALL(pthread_mutex_unlock, (&mutex_));
#endif
  }
}
```

### Wait

Object.wait()方法也是经常在synchronized块中用到的方法。
点击代码进去查看源码时可以看到它最终是一个native方法。

#### Object.wait() [Java]

```java
public final void wait(long timeout) throws InterruptedException {
    wait(timeout, 0);
}

@FastNative
// 发现是一个native方法，具体实现见2.3.2
public final native void wait(long timeout, int nanos) throws InterruptedException;
```

#### Object_waitWaitJI()

```c++
static void Object_waitJI(JNIEnv* env, jobject java_this, jlong ms, jint ns) {
  ScopedFastNativeObjectAccess soa(env);
  soa.Decode<mirror::Object>(java_this)->Wait(soa.Self(), ms, ns);
}
```

#### art::mirror::Object::Wait

```c++
inline void Object::Wait(Thread* self, int64_t ms, int32_t ns) {
  Monitor::Wait(self, this, ms, ns, true, ThreadState::kTimedWaiting);
}
```

#### static Monitor::Wait

```c++
void Monitor::Wait(Thread* self,
                   ObjPtr<mirror::Object> obj,
                   int64_t ms,
                   int32_t ns,
                   bool interruptShouldThrow,
                   ThreadState why) {
  // ...
  StackHandleScope<1> hs(self);
  Handle<mirror::Object> h_obj(hs.NewHandle(obj));

  // ...
  LockWord lock_word = h_obj->GetLockWord(true);
  // 如果已经是Fat LockWord，不用再走所膨胀流程，直接走后面的Monitor::Wait
  while (lock_word.GetState() != LockWord::kFatLocked) {
    switch (lock_word.GetState()) {
      case LockWord::kHashCode:
        // Fall-through.
      case LockWord::kUnlocked:
        ThrowIllegalMonitorStateExceptionF("object not locked by thread before wait()");
        return;  // Failure.
      case LockWord::kThinLocked: {
        uint32_t thread_id = self->GetThreadId();
        uint32_t owner_thread_id = lock_word.ThinLockOwner();
        // 只能在当前持有锁的线程调用wait()，否则抛出异常
        if (owner_thread_id != thread_id) {
          ThrowIllegalMonitorStateExceptionF("object not locked by thread before wait()");
          return;  // Failure.
        } else {
          // We own the lock, inflate to enqueue ourself on the Monitor. May fail spuriously so
          // re-load.
          // 进行锁膨胀
          Inflate(self, self, h_obj.Get(), 0);
          lock_word = h_obj->GetLockWord(true);
        }
        break;
      }
      case LockWord::kFatLocked:  // Unreachable given the loop condition above. Fall-through.
      default: {
        // LOG(FATAL) << "Invalid monitor state " << lock_word.GetState();
        // UNREACHABLE();
      }
    }
  }
  Monitor* mon = lock_word.FatLockMonitor();
  // 真正执行wait的地方，见2.3.5
  mon->Wait(self, ms, ns, interruptShouldThrow, why);
}
```

#### Monitor::Wait

```c++
void Monitor::Wait(Thread* self, int64_t ms, int32_t ns,
                   bool interruptShouldThrow, ThreadState why) {
  // ...
  // We need to turn a zero-length timed wait into a regular wait because
  // Object.wait(0, 0) is defined as Object.wait(0), which is defined as Object.wait().
  if (why == ThreadState::kTimedWaiting && (ms == 0 && ns == 0)) {
    why = ThreadState::kWaiting;
  }

  // ...
  /*
   * Release our hold - we need to let it go even if we're a few levels
   * deep in a recursive lock, and we need to restore that later.
   */
  unsigned int prev_lock_count = lock_count_;
  lock_count_ = 0;

  // ...

  bool was_interrupted = false;
  bool timed_out = false;
  // Update monitor state now; it's not safe once we're "suspended".
  owner_.store(nullptr, std::memory_order_relaxed);
  num_waiters_.fetch_add(1, std::memory_order_relaxed);
  {
    // Update thread state. If the GC wakes up, it'll ignore us, knowing
    // that we won't touch any references in this state, and we'll check
    // our suspend mode before we transition out.
    ScopedThreadSuspension sts(self, why);

    // Pseudo-atomically wait on self's wait_cond_ and release the monitor lock.
    MutexLock mu(self, *self->GetWaitMutex());

    /*
     * Add ourselves to the set of threads waiting on this monitor.
     * It's important that we are only added to the wait set after
     * acquiring our GetWaitMutex, so that calls to Notify() that occur after we
     * have released monitor_lock_ will not move us from wait_set_ to wake_set_
     * until we've signalled contenders on this monitor.
     */
    // 把自己加入wait_set_最后
    // wait_set_是一个链表
    AppendToWaitSet(self);

    // Set wait_monitor_ to the monitor object we will be waiting on. When wait_monitor_ is
    // non-null a notifying or interrupting thread must signal the thread's wait_cond_ to wake it
    // up.
    DCHECK(self->GetWaitMonitor() == nullptr);
    // wait_monitor_置空
    self->SetWaitMonitor(this);

    // Release the monitor lock.
    DCHECK(monitor_lock_.IsExclusiveHeld(self));
    // 见2.2.3
    SignalWaiterAndReleaseMonitorLock(self);

    // Handle the case where the thread was interrupted before we called wait().
    if (self->IsInterrupted()) {
      was_interrupted = true;
    } else {
      // Wait for a notification or a timeout to occur.
      if (why == ThreadState::kWaiting) {
        self->GetWaitConditionVariable()->Wait(self);
      } else {
        DCHECK(why == ThreadState::kTimedWaiting || why == ThreadState::kSleeping) << why;
        timed_out = self->GetWaitConditionVariable()->TimedWait(self, ms, ns);
      }
      was_interrupted = self->IsInterrupted();
    }
  }

  {
    // We reset the thread's wait_monitor_ field after transitioning back to runnable so
    // that a thread in a waiting/sleeping state has a non-null wait_monitor_ for debugging
    // and diagnostic purposes. (If you reset this earlier, stack dumps will claim that threads
    // are waiting on "null".)
    MutexLock mu(self, *self->GetWaitMutex());
    DCHECK(self->GetWaitMonitor() != nullptr);
    self->SetWaitMonitor(nullptr);
  }
  // end wait
  // ...

  // We just slept, tell the runtime callbacks about this.
  Runtime::Current()->GetRuntimeCallbacks()->MonitorWaitFinished(this, timed_out);

  // Re-acquire the monitor and lock.
  // 重新获取锁，在调用self->GetWaitConditionVariable()->notify()之前需要先Unlock
  // 见2.2.3 
  Lock<LockReason::kForWait>(self);
  lock_count_ = prev_lock_count;
  DCHECK(monitor_lock_.IsExclusiveHeld(self));
  self->GetWaitMutex()->AssertNotHeld(self);

  num_waiters_.fetch_sub(1, std::memory_order_relaxed);
  RemoveFromWaitSet(self);
}
```

### Notify

#### Object.notify() [java]

```java
@FastNative
// native方法，实现见2.4.2
public final native void notify();
```
##### Object_notify

```c++
static void Object_notify(JNIEnv* env, jobject java_this) {
  ScopedFastNativeObjectAccess soa(env);
  soa.Decode<mirror::Object>(java_this)->Notify(soa.Self());
}
```

##### art::mirror::Object::Notify

```c++
inline void Object::Notify(Thread* self) {
  Monitor::Notify(self, this);
}

```

##### static Monitor::Notify

```c++
 static void Notify(Thread* self, ObjPtr<mirror::Object> obj)
      REQUIRES_SHARED(Locks::mutator_lock_) {
    DoNotify(self, obj, false);
  }
```


##### Monitor::DoNotify

```c++
void Monitor::DoNotify(Thread* self, ObjPtr<mirror::Object> obj, bool notify_all) {
  // ...
  LockWord lock_word = obj->GetLockWord(true);
  switch (lock_word.GetState()) {
    case LockWord::kHashCode:
      // Fall-through.
    case LockWord::kUnlocked:
      ThrowIllegalMonitorStateExceptionF("object not locked by thread before notify()");
      return;  // Failure.
    case LockWord::kThinLocked: {
      uint32_t thread_id = self->GetThreadId();
      uint32_t owner_thread_id = lock_word.ThinLockOwner();
      if (owner_thread_id != thread_id) {
        ThrowIllegalMonitorStateExceptionF("object not locked by thread before notify()");
        return;  // Failure.
      } else {
        // We own the lock but there's no Monitor and therefore no waiters.
        return;  // Success.
      }
    }
    case LockWord::kFatLocked: {
      // 必须已经是Fat LockWord才可以，其他状态都抛异常
      Monitor* mon = lock_word.FatLockMonitor();
      if (notify_all) {
        mon->NotifyAll(self);
      } else {
        mon->Notify(self);
      }
      return;  // Success.
    }
    default: {
      LOG(FATAL) << "Invalid monitor state " << lock_word.GetState();
      UNREACHABLE();
    }
  }
}
```

##### Monitor::Notify

```c++
void Monitor::Notify(Thread* self) {
  // ...
  
  // 把wait_set_中的第一个放到wake_set_中
  // wait_set_构建见2.3.5
  // 这里指示移动元素，并不会释放锁并唤起等待的线程
  // 释放锁和唤起等待线程是在wait()或Monitor::MonitorExit的时候，分别见3.5和2.3
  Thread* to_move = wait_set_;
  if (to_move != nullptr) {
    wait_set_ = to_move->GetWaitNext();
    to_move->SetWaitNext(wake_set_);
    wake_set_ = to_move;
  }
}
```

#### Object.notifyAll() [java]

```java
@FastNative
public final native void notifyAll();
```

##### Object_notifyAll

```c++
static void Object_notifyAll(JNIEnv* env, jobject java_this) {
  ScopedFastNativeObjectAccess soa(env);
  soa.Decode<mirror::Object>(java_this)->NotifyAll(soa.Self());
}
```

##### art::mirror::Object::NotifyAll

```c++
inline void Object::NotifyAll(Thread* self) {
  Monitor::NotifyAll(self, this);
}
```

##### static Monitor::NotifyAll

```c++
 static void Notify(Thread* self, ObjPtr<mirror::Object> obj)
      REQUIRES_SHARED(Locks::mutator_lock_) {
    DoNotify(self, obj, false);
  }
```

##### Monitor::NotifyAll

```c++
void Monitor::NotifyAll(Thread* self) {
  // ...

  // 把wait_set_中的所有元素移动到wake_set_中
  // wait_set_构建见2.3.5
  // 这里指示移动元素，并不会释放锁并唤起等待的线程
  // 释放锁和唤起等待线程是在wait()或Monitor::MonitorExit的时候，分别见3.5和2.3
  Thread* to_move = wait_set_;
  if (to_move != nullptr) {
    wait_set_ = nullptr;
    Thread* move_to = wake_set_;
    if (move_to == nullptr) {
      wake_set_ = to_move;
      return;
    }
    while (move_to->GetWaitNext() != nullptr) {
      move_to = move_to->GetWaitNext();
    }
    move_to->SetWaitNext(to_move);
  }
}
```

## 总结

1. Object内部有shadow$_monitor_字段，其在native层对应的是一个LockWord。
2. LockWord是一个32位的无符号数，根据状态可分为thin、fat、hash、forwarding address状态。
3. synchronized加锁时，会根据lock_word_的状态，首先尝试使用自旋的方式进行加锁。
4. 如果当前线程是锁的owner，则自旋次数超过LockWord::kThinLockMaxCount次后进行锁膨胀。
5. 如果当前线程不是锁的owner，则自旋次数超过kExtraSpinIters后，会首先尝试将当前线程放到线程调度队列最后短暂让出CPU的方式进行休眠，如果多次后依然无法获取锁，并且次数已经超过了kExtraSpinIters+runtiem->GetMaxSpinsBeforeThinLockInflation，则进行锁的膨胀。
6. 锁膨胀时会挂起线程，修改lock_word_的状态为fat，同时在MonitorPool中生成Monitor并关联到当前object和线程。
7. 膨胀后的加锁和解锁分别用的是Monitor::Lock和Monitor::Unlock，其内部实现方式是用的Linux Futex系统调用。
8. 在Monitor::Unlock的时候会通知其他处于wake_list_的线程并逐个唤醒。
9. Object.wait()调用后会进行锁膨胀，线程通过GetWaitConditionVariable()获取的锁进行wait()休眠，并将当前线程加入到monitor的。wait_list_中，然后释放monitor_lock_，让其他线程有机会拿到monitor_lock_进入synchronized块内执行，在被唤醒后会重新获取monitor_lock_。
10. Object.notify()和Object.notifyAll()只是将线程从wait_list_中移动到wake_list_中，真正进行唤醒其他线程的逻辑是在monitorExit的时候和Object.wait()中调用Monitor::SignalWaiterAndReleaseMonitorLock()时候对其他线程进行唤醒。