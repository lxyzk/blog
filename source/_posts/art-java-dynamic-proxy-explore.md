---
title: Android ART 动态代理探究
date: 2022-08-01 00:41:26
tags:
- Java
- Android
- ART
- Proxy
categories: 
- Android
---


## 简单Demo

我们知道Java中提供了动态代理机制，可以动态进行代理，示例代码如下：

```
public class ProxyFactory {

    private Object target;

    public ProxyFactory(Object target) {
        this.target = target;
    }

    // 生成动态代理对象
    public Object getProxyInstance() {
        return Proxy.newProxyInstance(target.getClass().getClassLoader(), target.getClass().getInterfaces(),
                new InvocationHandler() {

                    @Override
                    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
                        System.out.println("开始调用真正的方法");

                        // 调用被代理对象的方法
                        Object returnValue = method.invoke(target, args);

                        System.out.println("结束调用真正的方法");
                        return null;
                    }
                });
    }
}
```

那么，动态代理在Android的ART中是怎么实现的呢？

下面通过阅读代码简单探究一下。

<!-- more -->

## 源码

### Proxy.newProxyInstance [Proxy.java]

```
@CallerSensitive
public static Object newProxyInstance(ClassLoader loader,
                                      Class<?>[] interfaces,
                                      InvocationHandler h)
    throws IllegalArgumentException
{
    Objects.requireNonNull(h);

    final Class<?>[] intfs = interfaces.clone();
    /*
     * Look up or generate the designated proxy class.
     */
    // 动态创建一个Proxy的子类，见2.1.1
    Class<?> cl = getProxyClass0(loader, intfs);

    /*
     * Invoke its constructor with the designated invocation handler.
     */
    try {
        final Constructor<?> cons = cl.getConstructor(constructorParams);
        final InvocationHandler ih = h;
        if (!Modifier.isPublic(cl.getModifiers())) {
            cons.setAccessible(true);
        }
        // 初始化子类，并将InvocationHandler传递过去
        // 上面创建的Proxy子类中，已经将要代理的method的入口地址设置为了
        // InvocationHandler.invoke()方法的入口
        // 因此在调用cl的方法时就会调用到h.invoke()方法
        return cons.newInstance(new Object[]{h});
    } catch (IllegalAccessException|InstantiationException e) {
        throw new InternalError(e.toString(), e);
    } catch (InvocationTargetException e) {
        Throwable t = e.getCause();
        if (t instanceof RuntimeException) {
            throw (RuntimeException) t;
        } else {
            throw new InternalError(t.toString(), t);
        }
    } catch (NoSuchMethodException e) {
        throw new InternalError(e.toString(), e);
    }
}
```

#### Proxy.getProxyClass0 [Proxy.java]

```
private static Class<?> getProxyClass0(ClassLoader loader,
                                       Class<?>... interfaces) {
    if (interfaces.length > 65535) {
        throw new IllegalArgumentException("interface limit exceeded");
    }

    // If the proxy class defined by the given loader implementing
    // the given interfaces exists, this will simply return the cached copy;
    // otherwise, it will create the proxy class via the ProxyClassFactory
    // 如果在缓存中可以找到，直接返回
    // 如果无法找到，调用ProxyClassFactory.apply()方法动态生成，
    // 具体原因见2.1.1.1    
    return proxyClassCache.get(loader, interfaces);
}
```

##### init WeakCache

```
private static final WeakCache<ClassLoader, Class<?>[], Class<?>>
    proxyClassCache = new WeakCache<>(new KeyFactory(), new ProxyClassFactory());
```

#### Proxy.ProxyClassFactory.apply [Proxy.java]

```
    @Override
    public Class<?> apply(ClassLoader loader, Class<?>[] interfaces) {

        Map<Class<?>, Boolean> interfaceSet = new IdentityHashMap<>(interfaces.length);
        // 判断interfaces里面是否有重复的，有重复抛出异常
        // 代码省略....
        
        // 判断是否non public interfaces都在同一个package中，如果不在，抛出异常
        // 代码省略....

        {
            // Android-changed: Generate the proxy directly instead of calling
            // through to ProxyGenerator.
            // 获取所有interface的声明方法
            List<Method> methods = getMethods(interfaces);
            Collections.sort(methods, ORDER_BY_SIGNATURE_AND_SUBTYPE);
            validateReturnTypes(methods);
            List<Class<?>[]> exceptions = deduplicateAndGetExceptions(methods);

            Method[] methodsArray = methods.toArray(new Method[methods.size()]);
            Class<?>[][] exceptionsArray = exceptions.toArray(new Class<?>[exceptions.size()][]);

            /*
             * Choose a name for the proxy class to generate.
             */
            long num = nextUniqueNumber.getAndIncrement();
            String proxyName = proxyPkg + proxyClassNamePrefix + num;
            
            // 生成proxy对象
            // 这是一个native方法
            return generateProxy(proxyName, interfaces, loader, methodsArray,
                                 exceptionsArray);
        }
    }
}
```

#### Proxy_generateProxy [java_lang_reflect_Proxy.cc]

```
static jclass Proxy_generateProxy(JNIEnv* env, jclass, jstring name, jobjectArray interfaces,
                                  jobject loader, jobjectArray methods, jobjectArray throws) {
  ScopedFastNativeObjectAccess soa(env);
  ClassLinker* class_linker = Runtime::Current()->GetClassLinker();
  return soa.AddLocalReference<jclass>(class_linker->CreateProxyClass(
      soa, name, interfaces, loader, methods, throws));
}
```

#### ClassLinker::CreateProxyClass [class_linker.cc]

```
ObjPtr<mirror::Class> ClassLinker::CreateProxyClass(ScopedObjectAccessAlreadyRunnable& soa,
                                                    jstring name,
                                                    jobjectArray interfaces,
                                                    jobject loader,
                                                    jobjectArray methods,
                                                    jobjectArray throws) {
  Thread* self = soa.Self();

  //...

  StackHandleScope<12> hs(self);
  // 初始化一个temp_kcass
  MutableHandle<mirror::Class> temp_klass(hs.NewHandle(
      AllocClass(self, GetClassRoot<mirror::Class>(this), sizeof(mirror::Class))));
  if (temp_klass == nullptr) {
    CHECK(self->IsExceptionPending());  // OOME.
    return nullptr;
  }
  // 给设置一堆标记位
  // ...

  // Proxies have 1 direct method, the constructor
  const size_t num_direct_methods = 1;

  // List of the actual virtual methods this class will have.
  std::vector<ArtMethod*> proxied_methods;
  
  // 这里会有一堆逻辑进行一下过滤，把private、final、static方法给过滤掉
  // 只留下virtual_methods，可以进行代理
  // ...
 
  const size_t num_virtual_methods = proxied_methods.size();
  // 处理throw methods
  // ...
  temp_klass->SetMethodsPtr(proxy_class_methods, num_direct_methods, num_virtual_methods);

  // Create the single direct method.
  CreateProxyConstructor(temp_klass, temp_klass->GetDirectMethodUnchecked(0, image_pointer_size_));

  // Create virtual method using specified prototypes.
  // TODO These should really use the iterators.
  for (size_t i = 0; i < num_virtual_methods; ++i) {
    auto* virtual_method = temp_klass->GetVirtualMethodUnchecked(i, image_pointer_size_);
    auto* prototype = proxied_methods[i];
    // 重点在这里，这里面会进行方法代理，见2.1.5
    CreateProxyMethod(temp_klass, prototype, virtual_method);
    DCHECK(virtual_method->GetDeclaringClass() != nullptr);
    DCHECK(prototype->GetDeclaringClass() != nullptr);
  }

  // 把父类设置为java.lang.reflect.Proxy
  temp_klass->SetSuperClass(GetClassRoot<mirror::Proxy>(this));
  // Now effectively in the loaded state.
  mirror::Class::SetStatus(temp_klass, ClassStatus::kLoaded, self);
  self->AssertNoPendingException();

  // At this point the class is loaded. Publish a ClassLoad event.
  // Note: this may be a temporary class. It is a listener's responsibility to handle this.
  Runtime::Current()->GetRuntimeCallbacks()->ClassLoad(temp_klass);

  MutableHandle<mirror::Class> klass = hs.NewHandle<mirror::Class>(nullptr);
  {
    // Must hold lock on object when resolved.
    ObjectLock<mirror::Class> resolution_lock(self, temp_klass);
    // Link the fields and virtual methods, creating vtable and iftables.
    // The new class will replace the old one in the class table.
    Handle<mirror::ObjectArray<mirror::Class>> h_interfaces(
        hs.NewHandle(soa.Decode<mirror::ObjectArray<mirror::Class>>(interfaces)));
    // 这里进行link，创建vtable和iftables
    if (!LinkClass(self, descriptor, temp_klass, h_interfaces, &klass)) {
      if (!temp_klass->IsErroneous()) {
        mirror::Class::SetStatus(temp_klass, ClassStatus::kErrorUnresolved, self);
      }
      return nullptr;
    }
  }

  Runtime::Current()->GetRuntimeCallbacks()->ClassPrepare(temp_klass, klass);

  VisiblyInitializedCallback* callback = nullptr;
  {
    // Lock on klass is released. Lock new class object.
    ObjectLock<mirror::Class> initialization_lock(self, klass);
    // Conservatively go through the ClassStatus::kInitialized state.
    callback = MarkClassInitialized(self, klass);
  }
  if (callback != nullptr) {
    callback->MakeVisible(self);
  }
  
  return klass.Get();
}
```

#### ClassLinker::CreateProxyMethod [class_linker.cc]

```
void ClassLinker::CreateProxyMethod(Handle<mirror::Class> klass, ArtMethod* prototype,
                                    ArtMethod* out) {
  // We steal everything from the prototype (such as DexCache, invoke stub, etc.) then specialize
  // as necessary
  DCHECK(out != nullptr);
  out->CopyFrom(prototype, image_pointer_size_);

  // Set class to be the concrete proxy class.
  out->SetDeclaringClass(klass.Get());

  // 设置一堆标记位
  // ...

  // Set the original interface method.
  out->SetDataPtrSize(prototype, image_pointer_size_);

  // At runtime the method looks like a reference and argument saving method, clone the code
  // related parameters from this method.
  // 将方法的入口设置为InvokeHandler的调用入口
  out->SetEntryPointFromQuickCompiledCode(GetQuickProxyInvokeHandler());
}
```

##### GetQuickproxyInvokeHandler [runtime_asm_entrypoints.h]

```
extern "C" void art_quick_proxy_invoke_handler();
static inline const void* GetQuickProxyInvokeHandler() {
  // 返回了art_quick_proxy_invoke_handler函数指针
  // art_quick_proxy_invoke_handler是一个汇编写的函数，以arm64为例，见2.1.5.2
  return reinterpret_cast<const void*>(art_quick_proxy_invoke_handler);
}
```

##### art_quick_proxy_invoke_handler [quick_entrypoints_arm64.S]

```
// x0寄存器保存方法名
// x1寄存器保存了上面创建的Poxy子类
ENTRY art_quick_proxy_invoke_handler
    SETUP_SAVE_REFS_AND_ARGS_FRAME_WITH_METHOD_IN_X0
    mov     x2, xSELF                   // pass Thread::Current
    mov     x3, sp                      // pass SP
    // 调用artQuickProxyInvokeHandler(Method *proxy_method, receiver, Thread*, SP)
    // artQuickProxyInvokeHandler的作用是调用Proxy的invoke方法
    // 见2.1.5.3
    bl      artQuickProxyInvokeHandler  // (Method* proxy method, receiver, Thread*, SP)
    ldr     x2, [xSELF, THREAD_EXCEPTION_OFFSET]
    cbnz    x2, .Lexception_in_proxy    // success if no exception is pending
    .cfi_remember_state
    RESTORE_SAVE_REFS_AND_ARGS_FRAME    // Restore frame
    REFRESH_MARKING_REGISTER
    fmov    d0, x0                      // Store result in d0 in case it was float or double
    ret                                 // return on success
.Lexception_in_proxy:
    CFI_RESTORE_STATE_AND_DEF_CFA sp, FRAME_SIZE_SAVE_REFS_AND_ARGS
    RESTORE_SAVE_REFS_AND_ARGS_FRAME
    DELIVER_PENDING_EXCEPTION
END art_quick_proxy_invoke_handler
```

##### artQuickProxyInvokeHandler [quick-trampoline_entrypoints.cc]

```
extern "C" uint64_t artQuickProxyInvokeHandler(
    ArtMethod* proxy_method, mirror::Object* receiver, Thread* self, ArtMethod** sp)
    REQUIRES_SHARED(Locks::mutator_lock_) {
  //...
  // 调用InvocationHandler的方法
  // 见 2.1.5.4
  JValue result = InvokeProxyInvocationHandler(soa, shorty, rcvr_jobj, interface_method_jobj, args);
  if (soa.Self()->IsExceptionPending()) {
    if (instr->HasMethodUnwindListeners()) {
      instr->MethodUnwindEvent(self,
                               proxy_method,
                               0);
    }
  } else if (instr->HasMethodExitListeners()) {
    instr->MethodExitEvent(self,
                           proxy_method,
                           {},
                           result);
  }
  return result.GetJ();
}
```

##### InvokeProxyInvocationHandler [entrypoint_utils.cc]

```
JValue InvokeProxyInvocationHandler(ScopedObjectAccessAlreadyRunnable& soa,
                                    const char* shorty,
                                    jobject rcvr_jobj,
                                    jobject interface_method_jobj,
                                    std::vector<jvalue>& args) {
   //...

  // Call Proxy.invoke(Proxy proxy, Method method, Object[] args).
  jvalue invocation_args[3];
  invocation_args[0].l = rcvr_jobj;
  invocation_args[1].l = interface_method_jobj;
  invocation_args[2].l = args_jobj;
  // 在这里调用Java层的Proxy.invoke(Proxy proxy, Method method, Object[] args)
  // 见2.1.5.5
  jobject result =
      soa.Env()->CallStaticObjectMethodA(WellKnownClasses::java_lang_reflect_Proxy,
                                         WellKnownClasses::java_lang_reflect_Proxy_invoke,
                                         invocation_args);

  //...
}
```

##### Proxy.invoke [Proxy.java]

```
private static Object invoke(Proxy proxy, Method method, Object[] args) throws Throwable {
    // 转了一圈，最终回到了这里，通过这里调用了InvocationHandler.invoke()方法
    InvocationHandler h = proxy.h;
    return h.invoke(proxy, method, args);
}
```

3.总结

1.  *Proxy.newProxyInstance()* 方法最终会通过调用*generateProxy()* native方法通过ClassLinker来创建一个实现了传入的interface的*java.lang.reflect.Proxy*的子类并返回

2.  创建的*Proxy*子类会将*method*的入口设置为调用*Proxy.invoke()* 方法入口，最终在*Proxy.invoke*中调用了*proxy*的*InvocationHandler*实例属性的*invoke()* 方法，最终调用到自己实现的*invoke*方法

3.  因此在调用*newProxyInstance()* 返回的子类的方法时，会调用到传入的*InvocationHandler.invoke()* 方法，然后在invoke方法中进行代理方法的实现
