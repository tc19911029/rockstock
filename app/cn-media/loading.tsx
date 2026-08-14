import { LoaderCircle } from 'lucide-react';

export default function Loading() {
  return (
    <div className="flex min-h-[55vh] items-center justify-center text-muted-foreground">
      <LoaderCircle className="mr-2 size-5 animate-spin" aria-hidden="true" />
      載入陸股節目資料…
    </div>
  );
}
